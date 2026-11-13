//! OpenCode through the Agent Client Protocol (`opencode acp`, JSON-RPC over stdio).
//!
//! Frame shapes follow OpenCode's real ACP traffic: `session/update` notifications
//! (`agent_message_chunk`, `tool_call`, `tool_call_update`, ...) and
//! `session/request_permission` requests that the host answers with an option id.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Value, json};

use super::backend::{
    AgentBackend, BackendContext, BackendEvent, BackendSession, Emitter, SubagentRoute, api_env,
    truncate_output,
};
use super::process::{ExitInfo, SpawnSpec, resolve_binary};
use super::rpc::{Incoming, RpcClient};
use crate::domain::agent::{AgentChoice, ModelChoice, SessionOptions};
use crate::domain::ids::TurnId;
use crate::domain::{
    Error, ErrorCode, PermissionDecision, PermissionRequestId, Result, SubagentUpdate, ToolCallId,
};

const BINARY_NAME: &str = "opencode";
const OVERRIDE_ENV: &str = "ATARAXIA_OPENCODE_BIN";
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(60);

enum Launcher {
    Resolve,
    Fixed { program: PathBuf, args: Vec<String> },
}

pub struct OpenCodeBackend {
    launcher: Launcher,
}

impl OpenCodeBackend {
    pub fn new() -> Self {
        Self {
            launcher: Launcher::Resolve,
        }
    }

    /// Runs an arbitrary ACP-speaking program instead of `opencode acp` (tests).
    pub fn with_command(program: PathBuf, args: Vec<String>) -> Self {
        Self {
            launcher: Launcher::Fixed { program, args },
        }
    }

    fn command(&self) -> std::result::Result<(PathBuf, Vec<String>), String> {
        match &self.launcher {
            Launcher::Fixed { program, args } => Ok((program.clone(), args.clone())),
            Launcher::Resolve => resolve_binary(BINARY_NAME, OVERRIDE_ENV)
                .map(|program| (program, vec!["acp".to_string()]))
                .ok_or_else(|| {
                    format!("opencode CLI not found. Install it or set {OVERRIDE_ENV} to its path.")
                }),
        }
    }
}

impl Default for OpenCodeBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentBackend for OpenCodeBackend {
    fn availability(&self) -> std::result::Result<(), String> {
        self.command().map(|_| ())
    }

    fn start(&self, ctx: BackendContext) -> Result<Arc<dyn BackendSession>> {
        let (program, args) = self
            .command()
            .map_err(|message| Error::new(ErrorCode::Unsupported, message))?;
        let shared = Arc::new(AcpShared {
            config: Mutex::new(Vec::new()),
            initial: Mutex::new(HashMap::new()),
            emit: ctx.emit,
            client: OnceLock::new(),
            acp_session_id: OnceLock::new(),
            exit: Mutex::new(None),
            state: Mutex::new(AcpState::default()),
        });
        let handler_shared = Arc::clone(&shared);
        let client = RpcClient::spawn(
            &SpawnSpec {
                program,
                args,
                cwd: ctx.cwd.clone(),
                env: api_env(ctx.session_id, ctx.api.as_ref()),
                env_remove: Vec::new(),
            },
            true,
            move |incoming| handler_shared.on_incoming(incoming),
        )?;
        let _ = shared.client.set(Arc::clone(&client));

        let handshake = (|| -> Result<()> {
            client.request(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        "fs": { "readTextFile": false, "writeTextFile": false },
                        "terminal": false
                    },
                    "clientInfo": {
                        "name": "ataraxia",
                        "title": "Ataraxia",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }),
                Some(HANDSHAKE_TIMEOUT),
            )?;
            let created = client.request(
                "session/new",
                json!({ "cwd": ctx.cwd.to_string_lossy(), "mcpServers": [] }),
                Some(HANDSHAKE_TIMEOUT),
            )?;
            let session_id = created
                .get("sessionId")
                .and_then(Value::as_str)
                .ok_or_else(|| Error::new(ErrorCode::Agent, "session/new returned no sessionId"))?;
            let _ = shared.acp_session_id.set(session_id.to_string());
            if let Some(options) = created.get("configOptions") {
                shared.remember_config(parse_config_options(options), true);
            }
            Ok(())
        })();
        if let Err(error) = handshake {
            let message = shared.with_exit_info(error.message);
            client.kill();
            return Err(Error::new(ErrorCode::Agent, message));
        }
        // Best effort: a stale saved model or agent must not stop the chat from opening.
        let _ = shared.apply(
            ctx.model.as_deref(),
            ctx.effort.as_deref(),
            ctx.agent
                .as_deref()
                .or(if ctx.read_only { Some("plan") } else { None }),
        );
        Ok(Arc::new(AcpSession { shared }))
    }
}

#[derive(Debug, Clone)]
struct AcpOption {
    id: String,
    kind: String,
}

struct QueuedPermission {
    request_id: PermissionRequestId,
    turn_id: TurnId,
    rpc_id: Value,
    tool_name: String,
    detail: String,
    options: Vec<AcpOption>,
}

struct ToolMeta {
    id: ToolCallId,
    name: String,
    input: String,
}

#[derive(Default)]
struct AcpState {
    turn: Option<TurnId>,
    cancel_requested: bool,
    tools: HashMap<String, ToolMeta>,
    queue: VecDeque<QueuedPermission>,
    active: Option<QueuedPermission>,
    /// Tool calls made inside child sessions → the call id shown in the subagent transcript.
    child_calls: HashMap<String, ToolCallId>,
    /// Child sessions seen so far (id → title), so updates addressed to one are recognised
    /// even without the `_meta` marker.
    children: HashMap<String, String>,
}

/// A subagent's child session, as marked by OpenCode on its updates.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ChildSession {
    id: String,
    title: String,
}

fn child_session(holder: &Value) -> Option<ChildSession> {
    let meta = holder.get("_meta")?.get("opencode/child-session")?;
    let id = meta.get("id")?.as_str()?.to_string();
    let title = meta
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.trim().is_empty())
        .unwrap_or("Subagent")
        .to_string();
    Some(ChildSession { id, title })
}

/// One selectable value of an ACP session config option.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ConfigValue {
    value: String,
    name: String,
    description: Option<String>,
}

/// An ACP session config option (`model`, `effort`, `mode`, ...), flattened.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ConfigOption {
    id: String,
    category: String,
    current: String,
    values: Vec<ConfigValue>,
}

impl ConfigOption {
    /// Matches by ACP category (`model`, `thought_level`, `mode`), falling back to the id.
    fn is(&self, category: &str, id: &str) -> bool {
        self.category == category || (self.category.is_empty() && self.id == id)
    }
}

fn parse_config_options(value: &Value) -> Vec<ConfigOption> {
    let Some(options) = value.as_array() else {
        return Vec::new();
    };
    options
        .iter()
        .filter(|option| {
            option
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("select")
                == "select"
        })
        .filter_map(|option| {
            let id = option.get("id")?.as_str()?.to_string();
            let current = option.get("currentValue")?.as_str()?.to_string();
            let category = option
                .get("category")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let mut values = Vec::new();
            let mut push = |item: &Value| {
                if let Some(value) = item.get("value").and_then(Value::as_str) {
                    values.push(ConfigValue {
                        value: value.to_string(),
                        name: item
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or(value)
                            .to_string(),
                        description: item
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    });
                }
            };
            for entry in option.get("options")?.as_array()? {
                // Either a flat list of values or a list of groups of values.
                match entry.get("options").and_then(Value::as_array) {
                    Some(group) => group.iter().for_each(&mut push),
                    None => push(entry),
                }
            }
            Some(ConfigOption {
                id,
                category,
                current,
                values,
            })
        })
        .collect()
}

struct AcpShared {
    /// Config options as last reported, and the values the session started with.
    config: Mutex<Vec<ConfigOption>>,
    initial: Mutex<HashMap<String, String>>,
    emit: Emitter,
    client: OnceLock<Arc<RpcClient>>,
    acp_session_id: OnceLock<String>,
    exit: Mutex<Option<ExitInfo>>,
    state: Mutex<AcpState>,
}

impl AcpShared {
    fn remember_config(&self, options: Vec<ConfigOption>, first: bool) {
        if first {
            let mut initial = self.initial.lock();
            for option in &options {
                initial.insert(option.id.clone(), option.current.clone());
            }
        }
        *self.config.lock() = options;
    }

    fn option_id(&self, category: &str, id: &str) -> Option<String> {
        self.config
            .lock()
            .iter()
            .find(|option| option.is(category, id))
            .map(|option| option.id.clone())
    }

    /// Sets one config option; the reply carries the complete, updated list.
    fn set_config(&self, config_id: &str, value: &str) -> Result<()> {
        let (Some(client), Some(session_id)) = (self.client.get(), self.acp_session_id.get())
        else {
            return Err(Error::new(ErrorCode::Agent, "opencode is not running"));
        };
        let reply = client.request(
            "session/set_config_option",
            json!({ "sessionId": session_id, "configId": config_id, "value": value }),
            Some(HANDSHAKE_TIMEOUT),
        )?;
        if let Some(options) = reply.get("configOptions") {
            self.remember_config(parse_config_options(options), false);
        }
        Ok(())
    }

    /// Moves the session to the wanted model, agent and effort; `None` means the default.
    fn apply(&self, model: Option<&str>, effort: Option<&str>, agent: Option<&str>) -> Result<()> {
        // Model first: the effort levels on offer depend on it.
        for (category, id, wanted) in [
            ("model", "model", model),
            ("mode", "mode", agent),
            ("thought_level", "effort", effort),
        ] {
            let Some(config_id) = self.option_id(category, id) else {
                continue;
            };
            let target = match wanted {
                Some(value) => Some(value.to_string()),
                // Back to default: the effort option has an explicit `default` value.
                None if category == "thought_level" => Some("default".to_string()),
                None => self.initial.lock().get(&config_id).cloned(),
            };
            let Some(target) = target else {
                continue;
            };
            let current = self
                .config
                .lock()
                .iter()
                .find(|option| option.id == config_id)
                .map(|option| option.current.clone());
            if current.as_deref() != Some(target.as_str()) {
                self.set_config(&config_id, &target)?;
            }
        }
        Ok(())
    }

    fn with_exit_info(&self, message: String) -> String {
        match self.exit.lock().as_ref() {
            Some(info) => info.describe("opencode"),
            None => message,
        }
    }

    fn on_incoming(&self, incoming: Incoming) {
        match incoming {
            Incoming::Notification { method, params } => {
                if method == "session/update" {
                    if let Some(update) = params.get("update") {
                        // Child (subagent) sessions ride on the prompt's session with a marker,
                        // or arrive under their own session id once prompted directly.
                        let child = child_session(&params)
                            .or_else(|| child_session(update))
                            .or_else(|| self.known_child(&params));
                        match child {
                            Some(child) => self.on_child_update(&child, update),
                            None => self.on_update(update),
                        }
                    }
                }
            }
            Incoming::Request { id, method, params } => {
                if method == "session/request_permission" {
                    self.on_permission(id, &params);
                } else if let Some(client) = self.client.get() {
                    let _ = client.respond_error(&id, -32601, "method not supported by Ataraxia");
                }
            }
            Incoming::Closed(info) => {
                let message = info.describe("opencode");
                *self.exit.lock() = Some(info);
                (self.emit)(BackendEvent::Error { message });
            }
        }
    }

    fn on_update(&self, update: &Value) {
        let kind = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let mut state = self.state.lock();
        let Some(turn_id) = state.turn else {
            return;
        };
        match kind {
            "agent_message_chunk" => {
                let text = update
                    .pointer("/content/text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !text.is_empty() {
                    (self.emit)(BackendEvent::Delta {
                        turn_id,
                        text: text.to_string(),
                    });
                }
            }
            "tool_call" | "tool_call_update" => {
                self.on_tool(&mut state, turn_id, update);
            }
            _ => {}
        }
    }

    /// The child session a `session/update` is addressed to, if it names one already seen.
    fn known_child(&self, params: &Value) -> Option<ChildSession> {
        let id = params.get("sessionId").and_then(Value::as_str)?;
        let title = self.state.lock().children.get(id)?.clone();
        Some(ChildSession {
            id: id.to_string(),
            title,
        })
    }

    fn on_child_update(&self, child: &ChildSession, update: &Value) {
        let kind = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let mut state = self.state.lock();
        state.children.insert(child.id.clone(), child.title.clone());
        let emit = |update: SubagentUpdate| {
            (self.emit)(BackendEvent::Subagent {
                id: child.id.clone(),
                title: child.title.clone(),
                update,
            });
        };
        match kind {
            "agent_message_chunk" => {
                let text = update
                    .pointer("/content/text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !text.is_empty() {
                    emit(SubagentUpdate::Delta {
                        text: text.to_string(),
                    });
                }
            }
            "tool_call" | "tool_call_update" => {
                let Some(acp_id) = update.get("toolCallId").and_then(Value::as_str) else {
                    return;
                };
                let call_id = match state.child_calls.get(acp_id) {
                    Some(call_id) => *call_id,
                    None => {
                        let call_id = ToolCallId::new();
                        state.child_calls.insert(acp_id.to_string(), call_id);
                        emit(SubagentUpdate::Tool {
                            call_id,
                            name: update
                                .get("title")
                                .and_then(Value::as_str)
                                .unwrap_or("tool")
                                .to_string(),
                            input: raw_input_text(update.get("rawInput")).unwrap_or_default(),
                        });
                        call_id
                    }
                };
                let status = update.get("status").and_then(Value::as_str);
                if matches!(status, Some("completed" | "failed")) {
                    emit(SubagentUpdate::ToolResult {
                        call_id,
                        output: tool_output(update),
                        ok: status == Some("completed"),
                    });
                }
            }
            _ => {}
        }
    }

    /// Announces a tool call the first time it is seen, then streams refinements.
    fn on_tool(&self, state: &mut AcpState, turn_id: TurnId, update: &Value) {
        let Some(acp_id) = update.get("toolCallId").and_then(Value::as_str) else {
            return;
        };
        let title = update.get("title").and_then(Value::as_str);
        let input = raw_input_text(update.get("rawInput"));

        let call_id = match state.tools.get_mut(acp_id) {
            Some(meta) => {
                let name = title
                    .filter(|title| *title != meta.name)
                    .map(str::to_string);
                let new_input = input.clone().filter(|input| *input != meta.input);
                if name.is_some() || new_input.is_some() {
                    if let Some(name) = &name {
                        meta.name = name.clone();
                    }
                    if let Some(input) = &new_input {
                        meta.input = input.clone();
                    }
                    (self.emit)(BackendEvent::ToolUpdate {
                        turn_id,
                        call_id: meta.id,
                        name,
                        input: new_input,
                    });
                }
                meta.id
            }
            None => self.announce_tool(state, turn_id, acp_id, title, input),
        };

        let status = update.get("status").and_then(Value::as_str);
        if matches!(status, Some("completed" | "failed")) {
            (self.emit)(BackendEvent::ToolResult {
                turn_id,
                call_id,
                output: tool_output(update),
                ok: status == Some("completed"),
            });
        }
    }

    fn announce_tool(
        &self,
        state: &mut AcpState,
        turn_id: TurnId,
        acp_id: &str,
        title: Option<&str>,
        input: Option<String>,
    ) -> ToolCallId {
        let id = ToolCallId::new();
        let name = title.unwrap_or("tool").to_string();
        let input = input.unwrap_or_default();
        state.tools.insert(
            acp_id.to_string(),
            ToolMeta {
                id,
                name: name.clone(),
                input: input.clone(),
            },
        );
        (self.emit)(BackendEvent::Tool {
            turn_id,
            call_id: id,
            name,
            input,
        });
        id
    }

    fn on_permission(&self, rpc_id: Value, params: &Value) {
        let mut state = self.state.lock();
        let Some(turn_id) = state.turn else {
            // Nothing is running: refuse rather than leave the agent hanging.
            drop(state);
            self.answer(&rpc_id, json!({ "outcome": { "outcome": "cancelled" } }));
            return;
        };
        let tool_call = params.get("toolCall").cloned().unwrap_or(Value::Null);
        let acp_id = tool_call
            .get("toolCallId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let title = tool_call.get("title").and_then(Value::as_str);
        let from_child = child_session(&tool_call).is_some();
        if !from_child && !acp_id.is_empty() && !state.tools.contains_key(&acp_id) {
            let input = raw_input_text(tool_call.get("rawInput"));
            self.announce_tool(&mut state, turn_id, &acp_id, title, input);
        }
        let options = params
            .get("options")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        Some(AcpOption {
                            id: item.get("optionId")?.as_str()?.to_string(),
                            kind: item.get("kind")?.as_str()?.to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let kind = tool_call
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("tool");
        state.queue.push_back(QueuedPermission {
            request_id: PermissionRequestId::new(),
            turn_id,
            rpc_id,
            tool_name: title.unwrap_or(kind).to_string(),
            detail: permission_detail(kind, &tool_call),
            options,
        });
        self.pump_permissions(&mut state);
    }

    /// Surfaces the next queued permission once the previous one is answered.
    fn pump_permissions(&self, state: &mut AcpState) {
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

    fn answer(&self, rpc_id: &Value, result: Value) {
        if let Some(client) = self.client.get() {
            let _ = client.respond(rpc_id, result);
        }
    }

    /// Prompts a child session directly and reports how it ended.
    fn run_child_prompt(&self, child: &str, text: &str) {
        let title = self
            .state
            .lock()
            .children
            .get(child)
            .cloned()
            .unwrap_or_else(|| "Subagent".to_string());
        let emit = |update: SubagentUpdate, title: &str| {
            (self.emit)(BackendEvent::Subagent {
                id: child.to_string(),
                title: title.to_string(),
                update,
            });
        };
        emit(SubagentUpdate::Started, &title);
        let Some(client) = self.client.get() else {
            return;
        };
        let outcome = client.request(
            "session/prompt",
            json!({
                "sessionId": child,
                "prompt": [{ "type": "text", "text": text }]
            }),
            None,
        );
        match outcome {
            Ok(result) => {
                let reason = result
                    .get("stopReason")
                    .and_then(Value::as_str)
                    .unwrap_or("end_turn");
                emit(
                    SubagentUpdate::Done {
                        ok: reason == "end_turn",
                    },
                    &title,
                );
            }
            Err(error) => {
                emit(
                    SubagentUpdate::Delta {
                        text: format!("\n\n(could not reach this subagent: {})", error.message),
                    },
                    &title,
                );
                emit(SubagentUpdate::Done { ok: false }, &title);
            }
        }
    }

    fn run_prompt(&self, turn_id: TurnId, text: String) {
        let Some(client) = self.client.get() else {
            return;
        };
        let Some(session_id) = self.acp_session_id.get() else {
            return;
        };
        let outcome = client.request(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": text }]
            }),
            None,
        );
        let cancelled = {
            let mut state = self.state.lock();
            state.turn = None;
            state.queue.clear();
            state.active = None;
            std::mem::take(&mut state.cancel_requested)
        };
        match outcome {
            Ok(result) => {
                let reason = result
                    .get("stopReason")
                    .and_then(Value::as_str)
                    .unwrap_or("end_turn");
                if !matches!(reason, "end_turn" | "cancelled") {
                    (self.emit)(BackendEvent::Delta {
                        turn_id,
                        text: format!("\n\n(stopped: {reason})"),
                    });
                }
                (self.emit)(BackendEvent::TurnDone {
                    turn_id,
                    ok: reason == "end_turn" && !cancelled,
                });
            }
            Err(error) => {
                (self.emit)(BackendEvent::Error {
                    message: self.with_exit_info(error.message),
                });
            }
        }
    }
}

struct AcpSession {
    shared: Arc<AcpShared>,
}

impl BackendSession for AcpSession {
    fn message_subagent(
        &self,
        _turn_id: TurnId,
        subagent_id: &str,
        text: &str,
    ) -> Result<SubagentRoute> {
        if !self.is_alive() {
            return Err(Error::new(
                ErrorCode::Agent,
                self.shared.with_exit_info("opencode is not running".into()),
            ));
        }
        let shared = Arc::clone(&self.shared);
        let (child, text) = (subagent_id.to_string(), text.to_string());
        thread::spawn(move || shared.run_child_prompt(&child, &text));
        Ok(SubagentRoute::Direct)
    }

    fn apply_settings(
        &self,
        model: Option<&str>,
        effort: Option<&str>,
        agent: Option<&str>,
    ) -> bool {
        self.shared.apply(model, effort, agent).is_ok()
    }

    fn options(&self) -> SessionOptions {
        let config = self.shared.config.lock();
        let values = |category: &str, id: &str| -> Vec<ConfigValue> {
            config
                .iter()
                .find(|option| option.is(category, id))
                .map(|option| option.values.clone())
                .unwrap_or_default()
        };
        let initial = self.shared.initial.lock();
        let default_model = config
            .iter()
            .find(|option| option.is("model", "model"))
            .and_then(|option| initial.get(&option.id).cloned());
        SessionOptions {
            models: values("model", "model")
                .into_iter()
                .map(|item| ModelChoice {
                    id: item.value,
                    label: item.name,
                    efforts: Vec::new(),
                })
                .collect(),
            default_model,
            // Levels of the model in use, without the explicit `default` entry.
            efforts: values("thought_level", "effort")
                .into_iter()
                .map(|item| item.value)
                .filter(|value| value != "default")
                .collect(),
            agents: values("mode", "mode")
                .into_iter()
                .map(|item| AgentChoice {
                    id: item.value,
                    label: item.name,
                    description: item.description,
                })
                .collect(),
        }
    }

    fn prompt(&self, turn_id: TurnId, text: &str) -> Result<()> {
        if !self.is_alive() {
            return Err(Error::new(
                ErrorCode::Agent,
                self.shared.with_exit_info("opencode is not running".into()),
            ));
        }
        {
            let mut state = self.shared.state.lock();
            state.turn = Some(turn_id);
            state.cancel_requested = false;
        }
        let shared = Arc::clone(&self.shared);
        let text = text.to_string();
        thread::spawn(move || shared.run_prompt(turn_id, text));
        Ok(())
    }

    fn cancel(&self) -> Result<()> {
        let rejected: Vec<Value> = {
            let mut state = self.shared.state.lock();
            if state.turn.is_none() {
                return Ok(());
            }
            state.cancel_requested = true;
            let mut ids: Vec<Value> = state.queue.drain(..).map(|item| item.rpc_id).collect();
            if let Some(active) = state.active.take() {
                ids.push(active.rpc_id);
            }
            ids
        };
        // ACP: outstanding permission requests must be answered `cancelled` on cancel.
        for rpc_id in rejected {
            self.shared
                .answer(&rpc_id, json!({ "outcome": { "outcome": "cancelled" } }));
        }
        if let (Some(client), Some(session_id)) =
            (self.shared.client.get(), self.shared.acp_session_id.get())
        {
            client.notify("session/cancel", json!({ "sessionId": session_id }))?;
        }
        Ok(())
    }

    fn resolve_permission(&self, decision: &PermissionDecision) -> Result<()> {
        let (rpc_id, outcome) = {
            let mut state = self.shared.state.lock();
            let matches_active = state
                .active
                .as_ref()
                .is_some_and(|active| active.request_id == decision.request_id);
            if !matches_active {
                return Err(Error::new(ErrorCode::Invalid, "no matching permission"));
            }
            let active = state.active.take().expect("checked above");
            let outcome = match pick_option(&active.options, decision.allow) {
                Some(option_id) => json!({ "outcome": "selected", "optionId": option_id }),
                None => json!({ "outcome": "cancelled" }),
            };
            (active.rpc_id, outcome)
        };
        self.shared.answer(&rpc_id, json!({ "outcome": outcome }));
        let mut state = self.shared.state.lock();
        self.shared.pump_permissions(&mut state);
        Ok(())
    }

    fn is_alive(&self) -> bool {
        self.shared
            .client
            .get()
            .is_some_and(|client| client.is_alive())
    }

    fn shutdown(&self) {
        if let Some(client) = self.shared.client.get() {
            client.kill();
        }
    }
}

/// Allow → `allow_once` (then `allow_always`); deny → `reject_once` (then `reject_always`).
fn pick_option(options: &[AcpOption], allow: bool) -> Option<String> {
    let order: [&str; 2] = if allow {
        ["allow_once", "allow_always"]
    } else {
        ["reject_once", "reject_always"]
    };
    order
        .iter()
        .find_map(|wanted| options.iter().find(|option| option.kind == *wanted))
        .map(|option| option.id.clone())
}

fn raw_input_text(raw: Option<&Value>) -> Option<String> {
    match raw {
        None | Some(Value::Null) => None,
        Some(Value::Object(map)) if map.is_empty() => None,
        Some(Value::String(text)) if text.is_empty() => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(other) => serde_json::to_string_pretty(other).ok(),
    }
}

fn permission_detail(kind: &str, tool_call: &Value) -> String {
    let raw = tool_call.get("rawInput");
    let command = raw
        .and_then(|raw| raw.get("command"))
        .and_then(Value::as_str);
    let path = tool_call
        .pointer("/locations/0/path")
        .and_then(Value::as_str)
        .or_else(|| {
            raw.and_then(|raw| raw.get("filepath").or_else(|| raw.get("filePath")))
                .and_then(Value::as_str)
        });
    let title = tool_call.get("title").and_then(Value::as_str);
    let subject = command.or(path).or(title).unwrap_or("this action");
    match kind {
        "execute" => format!("Allow running: {subject}"),
        "edit" => format!("Allow editing: {subject}"),
        "read" => format!("Allow reading: {subject}"),
        "delete" => format!("Allow deleting: {subject}"),
        _ => format!("Allow {kind}: {subject}"),
    }
}

fn tool_output(update: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(items) = update.get("content").and_then(Value::as_array) {
        for item in items {
            match item.get("type").and_then(Value::as_str) {
                Some("content") => {
                    if let Some(text) = item.pointer("/content/text").and_then(Value::as_str) {
                        parts.push(text.to_string());
                    }
                }
                Some("diff") => {
                    if let Some(path) = item.get("path").and_then(Value::as_str) {
                        parts.push(format!("Edited {path}"));
                    }
                }
                _ => {}
            }
        }
    }
    if parts.is_empty() {
        match update.get("rawOutput") {
            Some(Value::String(text)) => parts.push(text.clone()),
            Some(Value::Null) | None => {}
            Some(raw) => {
                let text = raw
                    .get("output")
                    .or_else(|| raw.get("error"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| serde_json::to_string_pretty(raw).ok());
                parts.extend(text);
            }
        }
    }
    truncate_output(parts.join("\n"))
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc::{self, Receiver};
    use std::time::Instant;

    use super::*;

    fn mock_backend() -> OpenCodeBackend {
        OpenCodeBackend::with_command(
            PathBuf::from("python3"),
            vec![
                concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/tests/fixtures/mock_acp_agent.py"
                )
                .into(),
            ],
        )
    }

    struct Harness {
        session: Arc<dyn BackendSession>,
        events: Receiver<BackendEvent>,
    }

    fn start() -> Harness {
        start_with(None, None, None)
    }

    fn start_with(model: Option<&str>, effort: Option<&str>, agent: Option<&str>) -> Harness {
        let (sender, events) = mpsc::channel();
        let sender = Mutex::new(sender);
        let session = mock_backend()
            .start(BackendContext {
                read_only: false,
                session_id: crate::domain::ids::SessionId::new(),
                cwd: std::env::temp_dir(),
                extra_dirs: Vec::new(),
                model: model.map(str::to_string),
                effort: effort.map(str::to_string),
                agent: agent.map(str::to_string),
                api: None,
                emit: Arc::new(move |event| {
                    let _ = sender.lock().send(event);
                }),
            })
            .expect("handshake with mock agent");
        Harness { session, events }
    }

    fn state_line(h: &Harness) -> String {
        h.session
            .prompt(TurnId::new(), "state please")
            .expect("prompt");
        let seen = h.until("turn done", is_turn_done);
        seen.iter()
            .filter_map(|event| match event {
                BackendEvent::Delta { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn models_effort_and_agents_come_from_the_session_config() {
        let h = start();
        let options = h.session.options();
        h.session.shutdown();
        let models: Vec<_> = options.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(models, ["mock/smart", "mock/fast"]);
        assert_eq!(options.default_model.as_deref(), Some("mock/smart"));
        assert_eq!(
            options.efforts,
            ["low", "high"],
            "the default entry is not a level"
        );
        let agents: Vec<_> = options.agents.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(agents, ["build", "plan"]);
        assert_eq!(options.agents[0].description.as_deref(), Some("Builds"));
    }

    #[test]
    fn saved_settings_are_applied_when_the_session_starts() {
        let h = start_with(Some("mock/smart"), Some("high"), Some("plan"));
        assert_eq!(state_line(&h), "model=mock/smart effort=high mode=plan");
        h.session.shutdown();
    }

    #[test]
    fn settings_change_live_and_return_to_defaults() {
        let h = start();
        assert!(
            h.session
                .apply_settings(Some("mock/fast"), None, Some("plan"))
        );
        assert_eq!(state_line(&h), "model=mock/fast effort=default mode=plan");
        // This model has no effort levels, so the picker must empty out.
        assert!(h.session.options().efforts.is_empty());
        assert!(h.session.apply_settings(None, None, None));
        assert_eq!(state_line(&h), "model=mock/smart effort=default mode=build");
        h.session.shutdown();
    }

    #[test]
    fn a_message_to_a_subagent_is_answered_in_its_own_conversation() {
        let h = start();
        // The child has to be seen first, as it is in a real run.
        h.session
            .prompt(TurnId::new(), "child please")
            .expect("prompt");
        h.until("turn done", is_turn_done);
        let route = h
            .session
            .message_subagent(TurnId::new(), "ses_child", "run the tests")
            .expect("message");
        assert_eq!(route, SubagentRoute::Direct);
        let seen = h.until("child reply done", |event| {
            matches!(
                event,
                BackendEvent::Subagent {
                    update: SubagentUpdate::Done { .. },
                    ..
                }
            )
        });
        h.session.shutdown();
        let reply: String = seen
            .iter()
            .filter_map(|event| match event {
                BackendEvent::Subagent {
                    id,
                    title,
                    update: SubagentUpdate::Delta { text },
                } => {
                    assert_eq!((id.as_str(), title.as_str()), ("ses_child", "Explore"));
                    Some(text.as_str())
                }
                _ => None,
            })
            .collect();
        assert_eq!(reply, "Child heard: run the tests");
        assert!(
            !seen
                .iter()
                .any(|event| matches!(event, BackendEvent::Delta { .. }))
        );
    }

    #[test]
    fn child_session_updates_become_a_subagent_conversation() {
        let h = start();
        h.session
            .prompt(TurnId::new(), "child please")
            .expect("prompt");
        let seen = h.until("turn done", is_turn_done);
        h.session.shutdown();
        let child: Vec<_> = seen
            .iter()
            .filter_map(|event| match event {
                BackendEvent::Subagent { id, title, update } => Some((id, title, update)),
                _ => None,
            })
            .collect();
        assert!(
            child
                .iter()
                .all(|(id, title, _)| *id == "ses_child" && *title == "Explore")
        );
        assert!(child.iter().any(
            |(_, _, update)| matches!(update, SubagentUpdate::Delta { text } if text == "Scanning")
        ));
        assert!(child.iter().any(
            |(_, _, update)| matches!(update, SubagentUpdate::Tool { name, .. } if name == "grep")
        ));
        assert!(child.iter().any(|(_, _, update)| matches!(
            update,
            SubagentUpdate::ToolResult { ok: true, output, .. } if output == "3 hits"
        )));
        // The child's chatter and tool stay out of the main conversation.
        let main: String = seen
            .iter()
            .filter_map(|event| match event {
                BackendEvent::Delta { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(main, "Delegating. Back.");
        assert!(
            !seen
                .iter()
                .any(|event| matches!(event, BackendEvent::Tool { .. }))
        );
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

    #[test]
    fn streams_a_plain_reply() {
        let h = start();
        let turn = TurnId::new();
        h.session.prompt(turn, "say hi").expect("prompt");
        let seen = h.until("turn done", is_turn_done);
        let text: String = seen
            .iter()
            .filter_map(|event| match event {
                BackendEvent::Delta { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(text, "Hello world");
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
        let turn = TurnId::new();
        h.session.prompt(turn, "tool please").expect("prompt");
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
    fn approved_tool_call_completes() {
        let seen = run_tool_turn(true);
        assert!(seen.iter().any(|event| matches!(
            event,
            BackendEvent::Tool { name, .. } if name == "write"
        )));
        assert!(seen.iter().any(|event| matches!(
            event,
            BackendEvent::ToolUpdate { input: Some(input), .. } if input.contains("/work/a.txt")
        )));
        assert!(seen.iter().any(|event| matches!(
            event,
            BackendEvent::Permission { detail, .. } if detail == "Allow editing: /work/a.txt"
        )));
        assert!(seen.iter().any(|event| matches!(
            event,
            BackendEvent::ToolResult { ok: true, output, .. } if output == "written"
        )));
        assert!(matches!(
            seen.last(),
            Some(BackendEvent::TurnDone { ok: true, .. })
        ));
    }

    #[test]
    fn denied_tool_call_fails() {
        let seen = run_tool_turn(false);
        assert!(seen.iter().any(|event| matches!(
            event,
            BackendEvent::ToolResult { ok: false, output, .. } if output.contains("rejected")
        )));
    }

    #[test]
    fn cancel_ends_the_turn_unsuccessfully() {
        let h = start();
        let turn = TurnId::new();
        h.session.prompt(turn, "hang").expect("prompt");
        h.until("first chunk", |event| {
            matches!(event, BackendEvent::Delta { .. })
        });
        h.session.cancel().expect("cancel");
        let seen = h.until("turn done", is_turn_done);
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
    fn process_exit_reports_stderr_and_marks_session_dead() {
        let h = start();
        h.session.prompt(TurnId::new(), "crash").expect("prompt");
        let seen = h.until("error", |event| matches!(event, BackendEvent::Error { .. }));
        assert!(seen.iter().any(|event| matches!(
            event,
            BackendEvent::Error { message } if message.contains("boom")
        )));
        let deadline = Instant::now() + Duration::from_secs(5);
        while h.session.is_alive() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(!h.session.is_alive());
        assert!(h.session.prompt(TurnId::new(), "again").is_err());
    }

    #[test]
    fn missing_binary_is_unavailable() {
        let backend = OpenCodeBackend::with_command(PathBuf::from("/definitely/not/here"), vec![]);
        assert!(backend.availability().is_ok());
        let error = backend
            .start(BackendContext {
                read_only: false,
                session_id: crate::domain::ids::SessionId::new(),
                cwd: std::env::temp_dir(),
                extra_dirs: Vec::new(),
                model: None,
                effort: None,
                agent: None,
                api: None,
                emit: Arc::new(|_| {}),
            })
            .err()
            .expect("spawn failure");
        assert_eq!(error.code, ErrorCode::Agent);
    }

    #[test]
    fn option_picking_prefers_once_variants() {
        let options = vec![
            AcpOption {
                id: "always".into(),
                kind: "allow_always".into(),
            },
            AcpOption {
                id: "once".into(),
                kind: "allow_once".into(),
            },
            AcpOption {
                id: "no".into(),
                kind: "reject_once".into(),
            },
        ];
        assert_eq!(pick_option(&options, true).as_deref(), Some("once"));
        assert_eq!(pick_option(&options, false).as_deref(), Some("no"));
        assert_eq!(pick_option(&options[..1], false), None);
    }
}
