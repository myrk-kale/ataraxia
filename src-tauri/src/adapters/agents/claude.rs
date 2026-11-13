//! Claude Code through its streaming JSON transport.
//!
//! The CLI runs as `claude -p --input-format stream-json --output-format stream-json
//! --permission-prompt-tool stdio`: user turns go in as `user` frames, output arrives as
//! `stream_event` / `assistant` / `user` / `result` frames, and tool permissions are asked
//! through `control_request` (`can_use_tool`) answered with `control_response`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;
use serde_json::{Value, json};
use uuid::Uuid;

use super::backend::{
    AgentBackend, BackendContext, BackendEvent, BackendSession, Emitter, SubagentRoute, api_env,
    truncate_output,
};
use super::definitions::claude_agents;
use super::process::{ExitInfo, ManagedProcess, SpawnSpec, resolve_binary};
use super::subagent_tail::{TailSpec, spawn_tail};
use crate::domain::agent::{ModelChoice, SessionOptions};
use crate::domain::ids::TurnId;
use crate::domain::{
    Error, ErrorCode, PermissionDecision, PermissionRequestId, Result, SubagentUpdate, ToolCallId,
};

const BINARY_NAME: &str = "claude";
const OVERRIDE_ENV: &str = "ATARAXIA_CLAUDE_BIN";
const PERMISSION_MODE_ENV: &str = "ATARAXIA_CLAUDE_PERMISSION_MODE";
const DEFAULT_PERMISSION_MODE: &str = "auto";

enum Launcher {
    Resolve,
    Fixed { program: PathBuf, args: Vec<String> },
}

pub struct ClaudeBackend {
    launcher: Launcher,
}

impl ClaudeBackend {
    pub fn new() -> Self {
        Self {
            launcher: Launcher::Resolve,
        }
    }

    /// Runs a stand-in program that speaks the same frames (tests).
    pub fn with_command(program: PathBuf, args: Vec<String>) -> Self {
        Self {
            launcher: Launcher::Fixed { program, args },
        }
    }

    fn command(
        &self,
        model: Option<&str>,
        effort: Option<&str>,
        agent: Option<&str>,
        read_only: bool,
    ) -> std::result::Result<(PathBuf, Vec<String>), String> {
        match &self.launcher {
            Launcher::Fixed { program, args } => Ok((program.clone(), args.clone())),
            Launcher::Resolve => resolve_binary(BINARY_NAME, OVERRIDE_ENV)
                .map(|program| {
                    // Read-only sessions run in plan mode, whatever the user configured.
                    let mode = if read_only {
                        Some("plan".to_string())
                    } else {
                        permission_mode()
                    };
                    (program, launch_args(mode.as_deref(), model, effort, agent))
                })
                .ok_or_else(|| {
                    format!(
                        "claude CLI not found. Install Claude Code or set {OVERRIDE_ENV} to its path."
                    )
                }),
        }
    }
}

/// The environment of the CLI: what makes it forward subagent text, and the local API.
fn claude_env(
    session_id: crate::domain::ids::SessionId,
    api: Option<&crate::ports::ApiAccess>,
) -> Vec<(String, String)> {
    // Without the first one the CLI leaves a foreground subagent's text out of the stream.
    let mut env = vec![("CLAUDE_CODE_FORWARD_SUBAGENT_TEXT".into(), "1".into())];
    env.extend(api_env(session_id, api));
    env
}

/// Permission mode passed to `claude --permission-mode`. Defaults to `auto`; set
/// `ATARAXIA_CLAUDE_PERMISSION_MODE` to another mode, or to an empty value to defer to the
/// user's own Claude settings.
fn permission_mode() -> Option<String> {
    match std::env::var(PERMISSION_MODE_ENV) {
        Ok(value) if value.trim().is_empty() => None,
        Ok(value) => Some(value.trim().to_string()),
        Err(_) => Some(DEFAULT_PERMISSION_MODE.to_string()),
    }
}

fn launch_args(
    mode: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    agent: Option<&str>,
) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-prompt-tool",
        "stdio",
    ]
    .map(String::from)
    .to_vec();
    if let Some(mode) = mode {
        args.push("--permission-mode".into());
        args.push(mode.into());
    }
    if let Some(model) = model {
        args.push("--model".into());
        args.push(model.into());
    }
    if let Some(effort) = effort {
        args.push("--effort".into());
        args.push(effort.into());
    }
    if let Some(agent) = agent {
        args.push("--agent".into());
        args.push(agent.into());
    }
    args
}

impl Default for ClaudeBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentBackend for ClaudeBackend {
    fn availability(&self) -> std::result::Result<(), String> {
        self.command(None, None, None, false).map(|_| ())
    }

    fn start(&self, ctx: BackendContext) -> Result<Arc<dyn BackendSession>> {
        let (program, args) = self
            .command(
                ctx.model.as_deref(),
                ctx.effort.as_deref(),
                ctx.agent.as_deref(),
                ctx.read_only,
            )
            .map_err(|message| Error::new(ErrorCode::Unsupported, message))?;
        let shared = Arc::new(ClaudeShared {
            emit: ctx.emit,
            process: OnceLock::new(),
            exit: Mutex::new(None),
            state: Mutex::new(ClaudeState::default()),
        });
        let line_shared = Arc::clone(&shared);
        let exit_shared = Arc::clone(&shared);
        let process = ManagedProcess::spawn(
            &SpawnSpec {
                program,
                args,
                cwd: ctx.cwd.clone(),
                env: claude_env(ctx.session_id, ctx.api.as_ref()),
                // A parent Claude Code session marks its children; strip it so we can nest.
                env_remove: vec!["CLAUDECODE".into(), "CLAUDE_CODE_ENTRYPOINT".into()],
            },
            move |line| line_shared.on_line(&line),
            move |info| exit_shared.on_exit(info),
        )?;
        let _ = shared.process.set(Arc::clone(&process));
        // The SDK opens with an `initialize` control request; the answer is not needed.
        let _ = process.write_line(
            &json!({
                "type": "control_request",
                "request_id": format!("init-{}", Uuid::new_v4()),
                "request": { "subtype": "initialize" }
            })
            .to_string(),
        );
        Ok(Arc::new(ClaudeSession {
            shared,
            cwd: ctx.cwd,
        }))
    }
}

struct QueuedPermission {
    request_id: PermissionRequestId,
    turn_id: TurnId,
    control_id: String,
    tool_use_id: String,
    tool_name: String,
    detail: String,
    input: Value,
}

struct ToolMeta {
    id: ToolCallId,
    name: String,
    input: String,
}

#[derive(Default)]
struct ClaudeState {
    turn: Option<TurnId>,
    cancel_requested: bool,
    tools: HashMap<String, ToolMeta>,
    /// API message ids whose text already streamed as deltas (the `assistant` frame repeats it).
    streamed: HashSet<String>,
    current_message: Option<String>,
    /// Partial-stream block index → tool_use id, for blocks that are tool calls.
    tool_blocks: HashMap<u64, String>,
    queue: VecDeque<QueuedPermission>,
    active: Option<QueuedPermission>,
    /// Agent/Task tool_use id → the subagent's title, so its frames can be attributed.
    subagent_titles: HashMap<String, String>,
    /// Tool_use ids that happened inside a subagent → the call id shown in its transcript.
    child_tools: HashMap<String, ToolCallId>,
    /// Agent/Task tool_use id → the `agentId` Claude reports when the subagent returns; it is
    /// what `SendMessage` needs to reach it again.
    agent_ids: HashMap<String, String>,
    /// Background subagents: tool_use id → the transcript file that follows them, and the flag
    /// that stops the tail reading it.
    tails: HashMap<String, (PathBuf, Arc<AtomicBool>)>,
    /// A background subagent was launched: the agent may speak again without being asked
    /// (to report it), so frames outside a turn start one instead of being dropped.
    background_seen: bool,
}

struct ClaudeShared {
    emit: Emitter,
    process: OnceLock<Arc<ManagedProcess>>,
    exit: Mutex<Option<ExitInfo>>,
    state: Mutex<ClaudeState>,
}

impl ClaudeShared {
    fn write(&self, frame: &Value) {
        if let Some(process) = self.process.get() {
            let _ = process.write_line(&frame.to_string());
        }
    }

    fn with_exit_info(&self, message: String) -> String {
        match self.exit.lock().as_ref() {
            Some(info) => info.describe("claude"),
            None => message,
        }
    }

    fn on_exit(&self, info: ExitInfo) {
        let message = info.describe("claude");
        *self.exit.lock() = Some(info);
        (self.emit)(BackendEvent::Error { message });
    }

    fn on_line(&self, line: &str) {
        let Ok(frame) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let parent = frame
            .get("parent_tool_use_id")
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(parent) = parent {
            // Frames from inside a subagent belong to its own conversation.
            match frame.get("type").and_then(Value::as_str) {
                Some("assistant") => self.on_child_assistant(&parent, &frame),
                Some("user") => self.on_child_user(&parent, &frame),
                _ => {}
            }
            return;
        }
        match frame.get("type").and_then(Value::as_str) {
            Some("stream_event") => self.on_stream_event(&frame),
            Some("assistant") => self.on_assistant(&frame),
            Some("user") => self.on_user(&frame),
            Some("result") => self.on_result(&frame),
            Some("control_request") => self.on_control_request(&frame),
            Some("control_cancel_request") => self.on_control_cancel(&frame),
            _ => {}
        }
    }

    fn on_stream_event(&self, frame: &Value) {
        let Some(event) = frame.get("event") else {
            return;
        };
        let mut state = self.state.lock();
        let Some(turn_id) = self.turn_or_unprompted(&mut state) else {
            return;
        };
        let index = event.get("index").and_then(Value::as_u64);
        match event.get("type").and_then(Value::as_str) {
            Some("message_start") => {
                state.current_message = event
                    .pointer("/message/id")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                state.tool_blocks.clear();
            }
            Some("content_block_start") => {
                let block = event.get("content_block").unwrap_or(&Value::Null);
                if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                    if let (Some(id), Some(index)) =
                        (block.get("id").and_then(Value::as_str), index)
                    {
                        let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                        self.announce_tool(&mut state, turn_id, id, name, None);
                        state.tool_blocks.insert(index, id.to_string());
                    }
                }
            }
            Some("content_block_delta") => {
                let delta = event.get("delta").unwrap_or(&Value::Null);
                if delta.get("type").and_then(Value::as_str) == Some("text_delta") {
                    let text = delta
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if !text.is_empty() {
                        if let Some(message) = state.current_message.clone() {
                            state.streamed.insert(message);
                        }
                        (self.emit)(BackendEvent::Delta {
                            turn_id,
                            text: text.to_string(),
                        });
                    }
                }
            }
            _ => {}
        }
    }

    fn on_assistant(&self, frame: &Value) {
        let mut state = self.state.lock();
        let Some(turn_id) = self.turn_or_unprompted(&mut state) else {
            return;
        };
        let message_id = frame
            .pointer("/message/id")
            .and_then(Value::as_str)
            .map(str::to_string);
        let already_streamed = message_id
            .as_ref()
            .is_some_and(|id| state.streamed.contains(id));
        let Some(blocks) = frame.pointer("/message/content").and_then(Value::as_array) else {
            return;
        };
        for block in blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("text") if !already_streamed => {
                    let text = block
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if !text.is_empty() {
                        (self.emit)(BackendEvent::Delta {
                            turn_id,
                            text: text.to_string(),
                        });
                    }
                }
                Some("tool_use") => {
                    let Some(id) = block.get("id").and_then(Value::as_str) else {
                        continue;
                    };
                    let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                    let input = input_text(block.get("input"));
                    self.announce_tool(&mut state, turn_id, id, name, input);
                }
                _ => {}
            }
        }
    }

    /// Announces a tool call once; later calls refine its name/input.
    fn announce_tool(
        &self,
        state: &mut ClaudeState,
        turn_id: TurnId,
        tool_use_id: &str,
        name: &str,
        input: Option<String>,
    ) -> ToolCallId {
        if let Some(meta) = state.tools.get_mut(tool_use_id) {
            let new_input = input.filter(|input| *input != meta.input);
            let new_name = (name != meta.name).then(|| name.to_string());
            if new_input.is_some() || new_name.is_some() {
                if let Some(input) = &new_input {
                    meta.input = input.clone();
                }
                if let Some(name) = &new_name {
                    meta.name = name.clone();
                }
                let (call_id, name, input) = (meta.id, meta.name.clone(), meta.input.clone());
                (self.emit)(BackendEvent::ToolUpdate {
                    turn_id,
                    call_id,
                    name: new_name,
                    input: new_input,
                });
                // The stream announces a tool before its input is known, so the subagent's
                // title is only available once the full message arrives.
                if is_subagent_tool(&name) {
                    self.note_subagent(state, tool_use_id, &input);
                }
                return call_id;
            }
            return meta.id;
        }
        let id = ToolCallId::new();
        let input = input.unwrap_or_default();
        state.tools.insert(
            tool_use_id.to_string(),
            ToolMeta {
                id,
                name: name.to_string(),
                input: input.clone(),
            },
        );
        let subagent_input = input.clone();
        (self.emit)(BackendEvent::Tool {
            turn_id,
            call_id: id,
            name: name.to_string(),
            input,
        });
        // Announced by the stream before its input is known: wait for the full message, which
        // carries the description the title is made from.
        if is_subagent_tool(name) && !subagent_input.is_empty() {
            self.note_subagent(state, tool_use_id, &subagent_input);
        }
        id
    }

    /// Registers (or retitles) the subagent a Task/Agent tool call starts.
    fn note_subagent(&self, state: &mut ClaudeState, tool_use_id: &str, input: &str) {
        let title = subagent_title(input);
        if state.subagent_titles.get(tool_use_id) == Some(&title) {
            return;
        }
        state
            .subagent_titles
            .insert(tool_use_id.to_string(), title.clone());
        (self.emit)(BackendEvent::Subagent {
            id: tool_use_id.to_string(),
            title,
            update: SubagentUpdate::Started,
        });
    }

    /// The running turn, or, once a background subagent exists, a new one for output nobody
    /// asked for (the report that follows the subagent finishing).
    fn turn_or_unprompted(&self, state: &mut ClaudeState) -> Option<TurnId> {
        if let Some(turn_id) = state.turn {
            return Some(turn_id);
        }
        if !state.background_seen || state.cancel_requested {
            return None;
        }
        let turn_id = TurnId::new();
        state.turn = Some(turn_id);
        (self.emit)(BackendEvent::TurnStarted { turn_id });
        Some(turn_id)
    }

    fn on_child_assistant(&self, parent: &str, frame: &Value) {
        let mut state = self.state.lock();
        let title = state
            .subagent_titles
            .get(parent)
            .cloned()
            .unwrap_or_else(|| "Subagent".to_string());
        let Some(blocks) = frame.pointer("/message/content").and_then(Value::as_array) else {
            return;
        };
        for block in blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    let text = block
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if !text.is_empty() {
                        (self.emit)(BackendEvent::Subagent {
                            id: parent.to_string(),
                            title: title.clone(),
                            update: SubagentUpdate::Delta {
                                text: text.to_string(),
                            },
                        });
                    }
                }
                Some("tool_use") => {
                    let Some(tool_use_id) = block.get("id").and_then(Value::as_str) else {
                        continue;
                    };
                    if state.child_tools.contains_key(tool_use_id) {
                        continue;
                    }
                    let call_id = ToolCallId::new();
                    state.child_tools.insert(tool_use_id.to_string(), call_id);
                    (self.emit)(BackendEvent::Subagent {
                        id: parent.to_string(),
                        title: title.clone(),
                        update: SubagentUpdate::Tool {
                            call_id,
                            name: block
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("tool")
                                .to_string(),
                            input: input_text(block.get("input")).unwrap_or_default(),
                        },
                    });
                }
                _ => {}
            }
        }
    }

    /// Starts following a background subagent's transcript, replacing an earlier tail.
    fn follow(
        &self,
        state: &mut ClaudeState,
        subagent_id: &str,
        title: &str,
        path: PathBuf,
        from_end: bool,
    ) {
        if let Some((_, stop)) = state.tails.remove(subagent_id) {
            stop.store(true, Ordering::SeqCst);
        }
        let stop = Arc::new(AtomicBool::new(false));
        state
            .tails
            .insert(subagent_id.to_string(), (path.clone(), Arc::clone(&stop)));
        spawn_tail(TailSpec {
            path,
            id: subagent_id.to_string(),
            title: title.to_string(),
            emit: Arc::clone(&self.emit),
            stop,
            from_end,
        });
    }

    fn stop_tails(&self) {
        for (_, stop) in self.state.lock().tails.values() {
            stop.store(true, Ordering::SeqCst);
        }
    }

    fn on_child_user(&self, parent: &str, frame: &Value) {
        let state = self.state.lock();
        let title = state
            .subagent_titles
            .get(parent)
            .cloned()
            .unwrap_or_else(|| "Subagent".to_string());
        let Some(blocks) = frame.pointer("/message/content").and_then(Value::as_array) else {
            return;
        };
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            let Some(call_id) = block
                .get("tool_use_id")
                .and_then(Value::as_str)
                .and_then(|id| state.child_tools.get(id))
            else {
                continue;
            };
            let is_error = block
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            (self.emit)(BackendEvent::Subagent {
                id: parent.to_string(),
                title: title.clone(),
                update: SubagentUpdate::ToolResult {
                    call_id: *call_id,
                    output: truncate_output(tool_result_text(block.get("content"))),
                    ok: !is_error,
                },
            });
        }
    }

    fn on_user(&self, frame: &Value) {
        let mut state = self.state.lock();
        let Some(turn_id) = state.turn else {
            return;
        };
        let Some(blocks) = frame.pointer("/message/content").and_then(Value::as_array) else {
            return;
        };
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            let Some(tool_use_id) = block.get("tool_use_id").and_then(Value::as_str) else {
                continue;
            };
            let Some(call_id) = state.tools.get(tool_use_id).map(|meta| meta.id) else {
                continue;
            };
            let is_error = block
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let output = tool_result_text(block.get("content"));
            // A subagent whose input never arrived still has to show up, if only generically.
            let unseen = state
                .tools
                .get(tool_use_id)
                .filter(|meta| is_subagent_tool(&meta.name))
                .map(|meta| meta.input.clone())
                .filter(|_| !state.subagent_titles.contains_key(tool_use_id));
            if let Some(input) = unseen {
                self.note_subagent(&mut state, tool_use_id, &input);
            }
            if let Some(title) = state.subagent_titles.get(tool_use_id).cloned() {
                // Claude reports the id needed to reach this subagent again.
                if let Some(agent_id) = parse_agent_id(&output) {
                    state.agent_ids.insert(tool_use_id.to_string(), agent_id);
                }
                if !is_error && is_background_launch(&output) {
                    // Not finished: it keeps working after this turn and reports later. Its
                    // transcript file is how its progress can be followed meanwhile.
                    state.background_seen = true;
                    (self.emit)(BackendEvent::Subagent {
                        id: tool_use_id.to_string(),
                        title: title.clone(),
                        update: SubagentUpdate::Detached,
                    });
                    if let Some(path) = parse_output_file(&output) {
                        self.follow(&mut state, tool_use_id, &title, path, false);
                    }
                } else {
                    (self.emit)(BackendEvent::Subagent {
                        id: tool_use_id.to_string(),
                        title,
                        update: SubagentUpdate::Done { ok: !is_error },
                    });
                }
            }
            (self.emit)(BackendEvent::ToolResult {
                turn_id,
                call_id,
                output: truncate_output(output),
                ok: !is_error,
            });
        }
    }

    fn on_result(&self, frame: &Value) {
        let (turn_id, cancelled) = {
            let mut state = self.state.lock();
            let Some(turn_id) = state.turn.take() else {
                return;
            };
            state.queue.clear();
            state.active = None;
            state.streamed.clear();
            state.tool_blocks.clear();
            state.current_message = None;
            (turn_id, std::mem::take(&mut state.cancel_requested))
        };
        let is_error = frame
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if is_error && !cancelled {
            let message = frame
                .get("result")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .unwrap_or("Claude reported an error")
                .to_string();
            // `Error` ends the turn in the host.
            (self.emit)(BackendEvent::Error { message });
            return;
        }
        (self.emit)(BackendEvent::TurnDone {
            turn_id,
            ok: !is_error && !cancelled,
        });
    }

    fn on_control_request(&self, frame: &Value) {
        let Some(control_id) = frame.get("request_id").and_then(Value::as_str) else {
            return;
        };
        let request = frame.get("request").unwrap_or(&Value::Null);
        if request.get("subtype").and_then(Value::as_str) != Some("can_use_tool") {
            self.write(&json!({
                "type": "control_response",
                "response": {
                    "subtype": "error",
                    "request_id": control_id,
                    "error": "request not supported by Ataraxia"
                }
            }));
            return;
        }
        let mut state = self.state.lock();
        let Some(turn_id) = state.turn else {
            drop(state);
            self.respond_permission(control_id, "", &Value::Null, false);
            return;
        };
        let tool_name = request
            .get("tool_name")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string();
        let tool_use_id = request
            .get("tool_use_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let input = request.get("input").cloned().unwrap_or(Value::Null);
        if !tool_use_id.is_empty() {
            self.announce_tool(
                &mut state,
                turn_id,
                &tool_use_id,
                &tool_name,
                input_text(Some(&input)),
            );
        }
        state.queue.push_back(QueuedPermission {
            request_id: PermissionRequestId::new(),
            turn_id,
            control_id: control_id.to_string(),
            tool_use_id,
            detail: permission_detail(&tool_name, &input, request),
            tool_name,
            input,
        });
        self.pump_permissions(&mut state);
    }

    fn on_control_cancel(&self, frame: &Value) {
        let Some(id) = frame.get("request_id").and_then(Value::as_str) else {
            return;
        };
        let mut state = self.state.lock();
        state.queue.retain(|item| item.control_id != id);
        if state
            .active
            .as_ref()
            .is_some_and(|active| active.control_id == id)
        {
            state.active = None;
            self.pump_permissions(&mut state);
        }
    }

    fn pump_permissions(&self, state: &mut ClaudeState) {
        if state.active.is_some() {
            return;
        }
        if let Some(next) = state.queue.pop_front() {
            (self.emit)(BackendEvent::Permission {
                turn_id: next.turn_id,
                request_id: next.request_id,
                tool_name: next.tool_name.clone(),
                detail: next.detail.clone(),
            });
            state.active = Some(next);
        }
    }

    fn respond_permission(&self, control_id: &str, tool_use_id: &str, input: &Value, allow: bool) {
        let response = if allow {
            json!({ "behavior": "allow", "updatedInput": input, "toolUseID": tool_use_id })
        } else {
            json!({
                "behavior": "deny",
                "message": "The user denied permission for this tool call.",
                "toolUseID": tool_use_id
            })
        };
        self.write(&json!({
            "type": "control_response",
            "response": { "subtype": "success", "request_id": control_id, "response": response }
        }));
    }
}

struct ClaudeSession {
    shared: Arc<ClaudeShared>,
    cwd: PathBuf,
}

impl BackendSession for ClaudeSession {
    fn message_subagent(
        &self,
        turn_id: TurnId,
        subagent_id: &str,
        text: &str,
    ) -> Result<SubagentRoute> {
        let (agent_id, title) = {
            let state = self.shared.state.lock();
            (
                state.agent_ids.get(subagent_id).cloned(),
                state
                    .subagent_titles
                    .get(subagent_id)
                    .cloned()
                    .unwrap_or_else(|| "Subagent".to_string()),
            )
        };
        let Some(agent_id) = agent_id else {
            return Err(Error::new(
                ErrorCode::Unsupported,
                "Claude only reports a subagent's id when it finishes, so it cannot be reached yet",
            ));
        };
        // The subagent's transcript keeps growing once it is resumed: follow it from here.
        {
            let mut state = self.shared.state.lock();
            if let Some((path, _)) = state.tails.get(subagent_id).cloned() {
                self.shared
                    .follow(&mut state, subagent_id, &title, path, true);
            }
        }
        // The main agent carries the message, so this is an ordinary turn.
        self.prompt(turn_id, &relay_prompt(&agent_id, &title, text))?;
        Ok(SubagentRoute::MainTurn)
    }

    fn options(&self) -> SessionOptions {
        SessionOptions {
            models: ["sonnet", "opus", "haiku", "fable"]
                .iter()
                .map(|id| ModelChoice {
                    id: (*id).to_string(),
                    label: capitalize(id),
                    efforts: Vec::new(),
                })
                .collect(),
            default_model: None,
            efforts: ["low", "medium", "high", "xhigh", "max"]
                .iter()
                .map(|level| (*level).to_string())
                .collect(),
            agents: claude_agents(&self.cwd),
        }
    }

    fn prompt(&self, turn_id: TurnId, text: &str) -> Result<()> {
        if !self.is_alive() {
            return Err(Error::new(
                ErrorCode::Agent,
                self.shared.with_exit_info("claude is not running".into()),
            ));
        }
        {
            let mut state = self.shared.state.lock();
            state.turn = Some(turn_id);
            state.cancel_requested = false;
        }
        let process = self
            .shared
            .process
            .get()
            .ok_or_else(|| Error::new(ErrorCode::Agent, "claude is not running"))?;
        process.write_line(
            &json!({
                "type": "user",
                "message": { "role": "user", "content": [{ "type": "text", "text": text }] },
                "parent_tool_use_id": null,
                "session_id": ""
            })
            .to_string(),
        )
    }

    fn cancel(&self) -> Result<()> {
        let denied: Vec<QueuedPermission> = {
            let mut state = self.shared.state.lock();
            if state.turn.is_none() {
                return Ok(());
            }
            state.cancel_requested = true;
            let mut all: Vec<_> = state.queue.drain(..).collect();
            all.extend(state.active.take());
            all
        };
        // Unblock the CLI before interrupting, otherwise it waits on the permission forever.
        for item in denied {
            self.shared
                .respond_permission(&item.control_id, &item.tool_use_id, &item.input, false);
        }
        self.shared.write(&json!({
            "type": "control_request",
            "request_id": format!("interrupt-{}", Uuid::new_v4()),
            "request": { "subtype": "interrupt" }
        }));
        Ok(())
    }

    fn resolve_permission(&self, decision: &PermissionDecision) -> Result<()> {
        let active = {
            let mut state = self.shared.state.lock();
            let matches_active = state
                .active
                .as_ref()
                .is_some_and(|active| active.request_id == decision.request_id);
            if !matches_active {
                return Err(Error::new(ErrorCode::Invalid, "no matching permission"));
            }
            state.active.take().expect("checked above")
        };
        self.shared.respond_permission(
            &active.control_id,
            &active.tool_use_id,
            &active.input,
            decision.allow,
        );
        let mut state = self.shared.state.lock();
        self.shared.pump_permissions(&mut state);
        Ok(())
    }

    fn is_alive(&self) -> bool {
        self.shared
            .process
            .get()
            .is_some_and(|process| process.is_alive())
    }

    fn shutdown(&self) {
        self.shared.stop_tails();
        if let Some(process) = self.shared.process.get() {
            process.kill();
        }
    }
}

/// True for the result of an Agent/Task call that returned before the subagent finished.
fn is_background_launch(output: &str) -> bool {
    let lower = output.to_ascii_lowercase();
    lower.contains("async agent launched") || lower.contains("async_launched")
}

/// The `output_file: <path>` line of a background launch: the subagent's live transcript.
fn parse_output_file(output: &str) -> Option<PathBuf> {
    let rest = output.split("output_file:").nth(1)?;
    let path = rest.lines().next()?.trim();
    (!path.is_empty()).then(|| PathBuf::from(path))
}

/// The `agentId: <id>` line Claude appends to a finished Agent/Task result.
fn parse_agent_id(text: &str) -> Option<String> {
    let rest = text.split("agentId:").nth(1)?;
    let id: String = rest
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .collect();
    (!id.is_empty()).then_some(id)
}

/// Claude reaches a finished subagent through the main agent's `SendMessage` tool.
fn relay_prompt(agent_id: &str, title: &str, text: &str) -> String {
    format!(
        "Use the SendMessage tool to send the following message to the subagent \"{title}\" \
         (agent id {agent_id}). Do not do the work yourself; pass it on and report its answer.\n\n{text}"
    )
}

fn is_subagent_tool(name: &str) -> bool {
    matches!(name, "Task" | "Agent")
}

/// A short title for the subagent a Task/Agent call starts, from its JSON input.
fn subagent_title(input: &str) -> String {
    let value: Value = serde_json::from_str(input).unwrap_or(Value::Null);
    ["description", "subagent_type", "name"]
        .iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| "Subagent".to_string())
}

fn capitalize(word: &str) -> String {
    let mut chars = word.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
        .unwrap_or_default()
}

pub(super) fn input_text(input: Option<&Value>) -> Option<String> {
    match input {
        None | Some(Value::Null) => None,
        Some(Value::Object(map)) if map.is_empty() => None,
        Some(other) => serde_json::to_string_pretty(other).ok(),
    }
}

pub(super) fn tool_result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn permission_detail(tool_name: &str, input: &Value, request: &Value) -> String {
    let text = |key: &str| input.get(key).and_then(Value::as_str);
    match tool_name {
        "Bash" => match text("command") {
            Some(command) => format!("Allow running: {command}"),
            None => "Allow running a shell command".into(),
        },
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => match text("file_path") {
            Some(path) => format!("Allow editing: {path}"),
            None => format!("Allow {tool_name}"),
        },
        "Read" => match text("file_path") {
            Some(path) => format!("Allow reading: {path}"),
            None => "Allow reading a file".into(),
        },
        _ => {
            let description = request
                .get("description")
                .and_then(Value::as_str)
                .or_else(|| request.get("display_name").and_then(Value::as_str));
            match description {
                Some(description) => format!("Allow {tool_name}: {description}"),
                None => format!("Allow {tool_name}"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn launch_args_carry_the_permission_mode() {
        let args = launch_args(Some("auto"), None, None, None);
        let at = args.iter().position(|a| a == "--permission-mode").unwrap();
        assert_eq!(args[at + 1], "auto");
        assert!(!launch_args(None, None, None, None).contains(&"--permission-mode".to_string()));
        let tuned = launch_args(None, Some("opus"), Some("high"), Some("code-reviewer"));
        let at = tuned.iter().position(|a| a == "--model").unwrap();
        assert_eq!(tuned[at + 1], "opus");
        let at = tuned.iter().position(|a| a == "--effort").unwrap();
        assert_eq!(tuned[at + 1], "high");
        let at = tuned.iter().position(|a| a == "--agent").unwrap();
        assert_eq!(tuned[at + 1], "code-reviewer");
        assert!(!launch_args(None, None, None, None).contains(&"--model".to_string()));
    }

    use std::sync::mpsc::{self, Receiver};
    use std::thread;
    use std::time::{Duration, Instant};

    use super::*;

    #[test]
    fn the_cli_gets_the_api_variables_next_to_its_own() {
        let session = crate::domain::ids::SessionId::new();
        let access = crate::ports::ApiAccess {
            url: "http://127.0.0.1:4000".into(),
            token: "tok".into(),
        };
        let env = claude_env(session, Some(&access));
        let get = |key: &str| env.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str());
        assert_eq!(get("CLAUDE_CODE_FORWARD_SUBAGENT_TEXT"), Some("1"));
        assert_eq!(get("ATARAXIA_API_URL"), Some("http://127.0.0.1:4000"));
        assert_eq!(get("ATARAXIA_API_TOKEN"), Some("tok"));
        assert_eq!(
            get("ATARAXIA_SESSION_ID"),
            Some(session.0.to_string().as_str())
        );
        assert_eq!(claude_env(session, None).len(), 1);
    }

    struct Harness {
        session: Arc<dyn BackendSession>,
        events: Receiver<BackendEvent>,
    }

    fn start() -> Harness {
        let backend = ClaudeBackend::with_command(
            PathBuf::from("python3"),
            vec![concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/mock_claude.py").into()],
        );
        let (sender, events) = mpsc::channel();
        let sender = Mutex::new(sender);
        let session = backend
            .start(BackendContext {
                read_only: false,
                session_id: crate::domain::ids::SessionId::new(),
                cwd: std::env::temp_dir(),
                model: None,
                effort: None,
                agent: None,
                api: None,
                emit: Arc::new(move |event| {
                    let _ = sender.lock().send(event);
                }),
            })
            .expect("start mock claude");
        Harness { session, events }
    }

    impl Harness {
        fn until(
            &self,
            what: &str,
            predicate: impl Fn(&BackendEvent) -> bool,
        ) -> Vec<BackendEvent> {
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut seen = Vec::new();
            while Instant::now() < deadline {
                if let Ok(event) = self.events.recv_timeout(Duration::from_millis(50)) {
                    let done = predicate(&event);
                    seen.push(event);
                    if done {
                        return seen;
                    }
                }
            }
            panic!("timed out waiting for {what}; saw {seen:?}");
        }
    }

    fn is_turn_done(event: &BackendEvent) -> bool {
        matches!(event, BackendEvent::TurnDone { .. })
    }

    fn deltas(events: &[BackendEvent]) -> String {
        events
            .iter()
            .filter_map(|event| match event {
                BackendEvent::Delta { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn streams_text_once_even_though_the_full_message_repeats_it() {
        let h = start();
        let turn = TurnId::new();
        h.session.prompt(turn, "say hi").expect("prompt");
        let seen = h.until("turn done", is_turn_done);
        assert_eq!(deltas(&seen), "Hello world");
        assert_eq!(
            seen.last(),
            Some(&BackendEvent::TurnDone {
                turn_id: turn,
                ok: true
            })
        );
        h.session.shutdown();
    }

    fn run_tool_turn(allow: bool) -> Vec<BackendEvent> {
        let h = start();
        h.session
            .prompt(TurnId::new(), "tool please")
            .expect("prompt");
        let mut seen = h.until("permission", |event| {
            matches!(event, BackendEvent::Permission { .. })
        });
        let request_id = match seen.last() {
            Some(BackendEvent::Permission { request_id, .. }) => *request_id,
            other => panic!("unexpected {other:?}"),
        };
        h.session
            .resolve_permission(&PermissionDecision { request_id, allow })
            .expect("resolve");
        seen.extend(h.until("turn done", is_turn_done));
        h.session.shutdown();
        seen
    }

    #[test]
    fn subagent_conversation_is_reported_separately_from_the_main_one() {
        let h = start();
        h.session
            .prompt(TurnId::new(), "subagent please")
            .expect("prompt");
        let seen = h.until("turn done", is_turn_done);
        h.session.shutdown();

        assert!(seen.iter().any(|event| matches!(
            event,
            BackendEvent::Tool { name, .. } if name == "Agent"
        )));
        let sub = |wanted: fn(&SubagentUpdate) -> bool| {
            seen.iter().any(|event| match event {
                BackendEvent::Subagent { id, title, update } => {
                    id == "toolu_agent" && title == "Explore the repo" && wanted(update)
                }
                _ => false,
            })
        };
        assert!(sub(|update| matches!(update, SubagentUpdate::Started)));
        assert!(sub(
            |update| matches!(update, SubagentUpdate::Tool { name, .. } if name == "Grep")
        ));
        assert!(sub(|update| matches!(
            update,
            SubagentUpdate::ToolResult { ok: true, output, .. } if output == "src/main.rs"
        )));
        assert!(sub(
            |update| matches!(update, SubagentUpdate::Delta { text } if text == "Found 1 entry point.")
        ));
        assert!(sub(|update| matches!(
            update,
            SubagentUpdate::Done { ok: true }
        )));
        // None of it leaks into the main conversation.
        assert_eq!(deltas(&seen), "Summary done.");
        assert!(!seen.iter().any(|event| matches!(
            event,
            BackendEvent::Tool { name, .. } if name == "Grep"
        )));
    }

    #[test]
    fn the_subagent_title_comes_from_the_full_message_not_the_empty_stream_announcement() {
        let h = start();
        h.session
            .prompt(TurnId::new(), "subagent please")
            .expect("prompt");
        let seen = h.until("turn done", is_turn_done);
        h.session.shutdown();
        let titles: Vec<&str> = seen
            .iter()
            .filter_map(|event| match event {
                BackendEvent::Subagent { title, .. } => Some(title.as_str()),
                _ => None,
            })
            .collect();
        assert!(!titles.is_empty());
        assert!(
            titles.iter().all(|title| *title == "Explore the repo"),
            "generic placeholder leaked: {titles:?}"
        );
    }

    #[test]
    fn a_background_subagent_is_followed_through_its_transcript_and_the_late_report_is_shown() {
        let h = start();
        h.session
            .prompt(TurnId::new(), "background please")
            .expect("prompt");
        let first = h.until("launch turn done", is_turn_done);
        let rest = h.until("late report done", |event| {
            matches!(event, BackendEvent::TurnDone { .. })
        });
        h.session.shutdown();
        let all: Vec<&BackendEvent> = first.iter().chain(rest.iter()).collect();

        let position = |wanted: fn(&SubagentUpdate) -> bool| {
            all.iter().position(|event| match event {
                BackendEvent::Subagent { id, update, .. } => id == "toolu_bg" && wanted(update),
                _ => false,
            })
        };
        // Launching is not finishing: it is only reported as done after the work was seen.
        let detached = position(|update| matches!(update, SubagentUpdate::Detached))
            .expect("launch reported as detached");
        let done = position(|update| matches!(update, SubagentUpdate::Done { ok: true }))
            .expect("finished once its transcript says so");
        assert!(detached < done);
        assert!(
            position(|update| matches!(update, SubagentUpdate::User { text } if text == "Explore the repo"))
                .is_some()
        );
        assert!(
            position(
                |update| matches!(update, SubagentUpdate::Tool { name, .. } if name == "Grep")
            )
            .is_some()
        );
        assert!(
            position(|update| matches!(
                update,
                SubagentUpdate::ToolResult { ok: true, output, .. } if output == "src/main.rs"
            ))
            .is_some()
        );
        let text = position(
            |update| matches!(update, SubagentUpdate::Delta { text } if text == "Found 1 entry point."),
        )
        .expect("its answer streamed in");
        assert!(text < done);

        // The title is the real one from the first announcement on.
        let titles: Vec<_> = all
            .iter()
            .filter_map(|event| match event {
                BackendEvent::Subagent { title, .. } => Some(title.as_str()),
                _ => None,
            })
            .collect();
        assert!(
            titles.iter().all(|title| *title == "Explorar a codebase"),
            "{titles:?}"
        );

        // The main agent speaks twice: the launch, then the report nobody asked for.
        assert_eq!(deltas(&first), "Launched in the background.");
        let started = rest
            .iter()
            .position(|event| matches!(event, BackendEvent::TurnStarted { .. }))
            .expect("the unprompted turn is announced");
        assert_eq!(deltas(&rest[started..]), "The subagent finished.");
    }

    #[test]
    fn output_without_a_background_subagent_is_still_ignored_outside_a_turn() {
        let h = start();
        h.session.prompt(TurnId::new(), "hello").expect("prompt");
        h.until("turn done", is_turn_done);
        h.session.shutdown();
        // Nothing was launched, so no stray turn can have been invented.
        assert!(
            h.events
                .try_iter()
                .all(|event| !matches!(event, BackendEvent::TurnStarted { .. }))
        );
    }

    #[test]
    fn background_launches_and_their_files_are_recognised_in_the_real_result_text() {
        let real = "Async agent launched successfully. (This tool result is internal metadata \u{2014} never quote it.)\n\
            agentId: a241b83d4303976a4 (internal ID - do not mention to user. Use SendMessage with to: 'a241b83d4303976a4')\n\
            The agent is working in the background.\n\
            output_file: /private/tmp/claude-501/-Users-me-proj/048fa7e1/tasks/a241b83d4303976a4.output\n";
        assert!(is_background_launch(real));
        assert!(is_background_launch("status: async_launched"));
        assert!(!is_background_launch(
            "agentId: abc\nThe subagent finished."
        ));
        assert_eq!(parse_agent_id(real), Some("a241b83d4303976a4".into()));
        assert_eq!(
            parse_output_file(real),
            Some(PathBuf::from(
                "/private/tmp/claude-501/-Users-me-proj/048fa7e1/tasks/a241b83d4303976a4.output"
            ))
        );
        assert_eq!(parse_output_file("no file here"), None);
    }

    #[test]
    fn a_finished_subagent_can_be_messaged_through_the_main_agent() {
        let h = start();
        h.session
            .prompt(TurnId::new(), "subagent please")
            .expect("prompt");
        h.until("first turn done", is_turn_done);

        let turn = TurnId::new();
        let route = h
            .session
            .message_subagent(turn, "toolu_agent", "also check the tests")
            .expect("message");
        assert_eq!(route, SubagentRoute::MainTurn);
        let seen = h.until("relay done", is_turn_done);
        h.session.shutdown();
        assert!(seen.iter().any(|event| matches!(
            event,
            BackendEvent::Tool { name, .. } if name == "SendMessage"
        )));
        assert!(seen.iter().any(|event| matches!(
            event,
            BackendEvent::Subagent { id, update: SubagentUpdate::Delta { text }, .. }
                if id == "toolu_agent" && text == "Resumed and replying."
        )));
        assert!(matches!(
            seen.last(),
            Some(BackendEvent::TurnDone { turn_id, ok: true }) if *turn_id == turn
        ));
    }

    #[test]
    fn a_subagent_that_has_not_returned_yet_cannot_be_reached() {
        let h = start();
        let error = h
            .session
            .message_subagent(TurnId::new(), "toolu_unknown", "hi")
            .expect_err("no agent id yet");
        h.session.shutdown();
        assert!(error.message.contains("id"), "{}", error.message);
    }

    #[test]
    fn agent_id_is_read_from_the_tool_result_text() {
        assert_eq!(
            parse_agent_id("Done.\nagentId: a1b2c3"),
            Some("a1b2c3".into())
        );
        assert_eq!(
            parse_agent_id("agentId: abc-123 (use SendMessage)"),
            Some("abc-123".into())
        );
        assert_eq!(parse_agent_id("no id here"), None);
        assert!(relay_prompt("a1", "Explore", "hi").contains("agent id a1"));
    }

    #[test]
    fn approved_tool_runs_and_reports_its_result() {
        let seen = run_tool_turn(true);
        assert!(seen.iter().any(|event| matches!(
            event,
            BackendEvent::Tool { name, .. } if name == "Bash"
        )));
        assert!(seen.iter().any(|event| matches!(
            event,
            BackendEvent::ToolUpdate { input: Some(input), .. } if input.contains("touch probe.txt")
        )));
        assert!(seen.iter().any(|event| matches!(
            event,
            BackendEvent::Permission { detail, .. } if detail == "Allow running: touch probe.txt"
        )));
        assert!(seen.iter().any(|event| matches!(
            event,
            BackendEvent::ToolResult { ok: true, output, .. } if output == "created"
        )));
        assert_eq!(deltas(&seen), "All done.");
        assert!(matches!(
            seen.last(),
            Some(BackendEvent::TurnDone { ok: true, .. })
        ));
    }

    #[test]
    fn denied_tool_reports_an_error_result() {
        let seen = run_tool_turn(false);
        assert!(seen.iter().any(|event| matches!(
            event,
            BackendEvent::ToolResult { ok: false, output, .. } if output.contains("denied")
        )));
    }

    #[test]
    fn interrupt_ends_the_turn_without_an_error_event() {
        let h = start();
        let turn = TurnId::new();
        h.session.prompt(turn, "hang").expect("prompt");
        h.until("first delta", |event| {
            matches!(event, BackendEvent::Delta { .. })
        });
        h.session.cancel().expect("cancel");
        let seen = h.until("turn done", is_turn_done);
        assert!(
            !seen
                .iter()
                .any(|event| matches!(event, BackendEvent::Error { .. }))
        );
        assert_eq!(
            seen.last(),
            Some(&BackendEvent::TurnDone {
                turn_id: turn,
                ok: false
            })
        );
        h.session.shutdown();
    }

    #[test]
    fn crash_reports_stderr_and_marks_session_dead() {
        let h = start();
        h.session.prompt(TurnId::new(), "crash").expect("prompt");
        let seen = h.until("error", |event| matches!(event, BackendEvent::Error { .. }));
        assert!(seen.iter().any(|event| matches!(
            event,
            BackendEvent::Error { message } if message.contains("claude exploded")
        )));
        let deadline = Instant::now() + Duration::from_secs(5);
        while h.session.is_alive() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(!h.session.is_alive());
    }

    #[test]
    fn permission_text_names_the_subject() {
        let input = json!({ "file_path": "/w/a.rs" });
        assert_eq!(
            permission_detail("Edit", &input, &Value::Null),
            "Allow editing: /w/a.rs"
        );
        assert_eq!(
            permission_detail(
                "WebFetch",
                &Value::Null,
                &json!({ "description": "fetch docs" })
            ),
            "Allow WebFetch: fetch docs"
        );
    }
}
