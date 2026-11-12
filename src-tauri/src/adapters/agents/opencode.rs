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
    AgentBackend, BackendContext, BackendEvent, BackendSession, Emitter, truncate_output,
};
use super::process::{ExitInfo, SpawnSpec, resolve_binary};
use super::rpc::{Incoming, RpcClient};
use crate::domain::ids::TurnId;
use crate::domain::{
    Error, ErrorCode, PermissionDecision, PermissionRequestId, Result, ToolCallId,
};

const BINARY_NAME: &str = "opencode";
const OVERRIDE_ENV: &str = "CONCIERGE_OPENCODE_BIN";
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
                env: Vec::new(),
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
                        "name": "concierge",
                        "title": "Concierge",
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
            Ok(())
        })();
        if let Err(error) = handshake {
            let message = shared.with_exit_info(error.message);
            client.kill();
            return Err(Error::new(ErrorCode::Agent, message));
        }
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
}

struct AcpShared {
    emit: Emitter,
    client: OnceLock<Arc<RpcClient>>,
    acp_session_id: OnceLock<String>,
    exit: Mutex<Option<ExitInfo>>,
    state: Mutex<AcpState>,
}

impl AcpShared {
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
                        self.on_update(update);
                    }
                }
            }
            Incoming::Request { id, method, params } => {
                if method == "session/request_permission" {
                    self.on_permission(id, &params);
                } else if let Some(client) = self.client.get() {
                    let _ = client.respond_error(&id, -32601, "method not supported by Concierge");
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
        if !acp_id.is_empty() && !state.tools.contains_key(&acp_id) {
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
        let (sender, events) = mpsc::channel();
        let sender = Mutex::new(sender);
        let session = mock_backend()
            .start(BackendContext {
                session_id: crate::domain::ids::SessionId::new(),
                cwd: std::env::temp_dir(),
                model: None,
                effort: None,
                agent: None,
                emit: Arc::new(move |event| {
                    let _ = sender.lock().send(event);
                }),
            })
            .expect("handshake with mock agent");
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
                session_id: crate::domain::ids::SessionId::new(),
                cwd: std::env::temp_dir(),
                model: None,
                effort: None,
                agent: None,
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
