//! Line-delimited JSON-RPC 2.0 client over a child process (ACP, Codex app-server).
//!
//! The handler runs on the stdout reader thread: it must not issue blocking requests.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Value, json};

use super::process::{ExitInfo, ManagedProcess, SpawnSpec};
use crate::domain::{Error, ErrorCode, Result};

#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    Notification {
        method: String,
        params: Value,
    },
    /// A request from the agent; answer with [`RpcClient::respond`].
    Request {
        id: Value,
        method: String,
        params: Value,
    },
    Closed(ExitInfo),
}

type Pending = Arc<Mutex<HashMap<u64, Sender<std::result::Result<Value, String>>>>>;

pub struct RpcClient {
    process: Arc<ManagedProcess>,
    pending: Pending,
    next_id: AtomicU64,
    /// Codex's app-server omits the `"jsonrpc":"2.0"` member.
    version_field: bool,
}

impl RpcClient {
    pub fn spawn(
        spec: &SpawnSpec,
        version_field: bool,
        handler: impl Fn(Incoming) + Send + Sync + 'static,
    ) -> Result<Arc<Self>> {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let handler = Arc::new(handler);

        let line_pending = Arc::clone(&pending);
        let line_handler = Arc::clone(&handler);
        let exit_pending = Arc::clone(&pending);
        let exit_handler = Arc::clone(&handler);

        let process = ManagedProcess::spawn(
            spec,
            move |line| dispatch_line(&line, &line_pending, line_handler.as_ref()),
            move |info| {
                // Record the process exit before waking blocked requests, so their errors can
                // include the exit status and stderr rather than racing the exit notification.
                exit_handler(Incoming::Closed(info));
                exit_pending.lock().clear();
            },
        )?;
        Ok(Arc::new(Self {
            process,
            pending,
            next_id: AtomicU64::new(1),
            version_field,
        }))
    }

    pub fn is_alive(&self) -> bool {
        self.process.is_alive()
    }

    pub fn pid(&self) -> u32 {
        self.process.pid()
    }

    pub fn kill(&self) {
        self.process.kill();
    }

    fn frame(&self, mut body: Value) -> Value {
        if self.version_field {
            body["jsonrpc"] = json!("2.0");
        }
        body
    }

    fn send(&self, body: Value) -> Result<()> {
        self.process.write_line(&self.frame(body).to_string())
    }

    pub fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.send(json!({ "method": method, "params": params }))
    }

    /// Notification without a `params` member (e.g. Codex's `initialized`).
    pub fn notify_bare(&self, method: &str) -> Result<()> {
        self.send(json!({ "method": method }))
    }

    pub fn respond(&self, id: &Value, result: Value) -> Result<()> {
        self.send(json!({ "id": id, "result": result }))
    }

    pub fn respond_error(&self, id: &Value, code: i64, message: &str) -> Result<()> {
        self.send(json!({ "id": id, "error": { "code": code, "message": message } }))
    }

    /// Sends a request and blocks for its response.
    pub fn request(&self, method: &str, params: Value, timeout: Option<Duration>) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = mpsc::channel();
        self.pending.lock().insert(id, sender);
        if let Err(error) = self.send(json!({ "id": id, "method": method, "params": params })) {
            self.pending.lock().remove(&id);
            return Err(error);
        }
        let outcome = match timeout {
            Some(limit) => receiver.recv_timeout(limit).map_err(|error| match error {
                mpsc::RecvTimeoutError::Timeout => format!("{method} timed out"),
                mpsc::RecvTimeoutError::Disconnected => "agent process exited".to_string(),
            }),
            None => receiver
                .recv()
                .map_err(|_| "agent process exited".to_string()),
        };
        match outcome {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(message)) | Err(message) => {
                self.pending.lock().remove(&id);
                Err(Error::new(ErrorCode::Agent, message))
            }
        }
    }
}

fn dispatch_line(line: &str, pending: &Pending, handler: &(dyn Fn(Incoming) + Send + Sync)) {
    let Ok(frame) = serde_json::from_str::<Value>(line) else {
        return;
    };
    let method = frame.get("method").and_then(Value::as_str);
    let id = frame.get("id").cloned().filter(|id| !id.is_null());
    match (method, id) {
        (Some(method), Some(id)) => handler(Incoming::Request {
            id,
            method: method.to_string(),
            params: frame.get("params").cloned().unwrap_or(Value::Null),
        }),
        (Some(method), None) => handler(Incoming::Notification {
            method: method.to_string(),
            params: frame.get("params").cloned().unwrap_or(Value::Null),
        }),
        (None, Some(id)) => {
            let Some(id) = id.as_u64() else {
                return;
            };
            let Some(sender) = pending.lock().remove(&id) else {
                return;
            };
            let outcome = match frame.get("error") {
                Some(error) => Err(error_text(error)),
                None => Ok(frame.get("result").cloned().unwrap_or(Value::Null)),
            };
            let _ = sender.send(outcome);
        }
        (None, None) => {}
    }
}

/// The longest explanation taken from an error's `data`.
const MAX_DETAIL_CHARS: usize = 500;
/// Where agents put the sentence that explains an error, in the order they are tried.
const DETAIL_KEYS: [&str; 4] = ["details", "message", "error", "reason"];

/// What an agent says went wrong: the `message` of its JSON-RPC error, plus whatever it explains
/// in `data`. Cursor answers a bare `Internal error` and keeps the cause in `data.details`; a
/// request it refuses lists the fields it did not accept there.
fn error_text(error: &Value) -> String {
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .filter(|message| !message.trim().is_empty())
        .unwrap_or("agent returned an error");
    match error.get("data").and_then(error_detail) {
        Some(detail) if !message.contains(&detail) => format!("{message}: {detail}"),
        _ => message.to_string(),
    }
}

fn error_detail(data: &Value) -> Option<String> {
    let text = match data {
        Value::String(text) => text.trim().to_string(),
        Value::Object(fields) => match DETAIL_KEYS
            .iter()
            .find_map(|key| fields.get(*key).and_then(error_detail))
        {
            Some(detail) => detail,
            None => {
                let mut problems = Vec::new();
                validation_problems(data, "", &mut problems);
                if problems.is_empty() {
                    data.to_string()
                } else {
                    problems.join("; ")
                }
            }
        },
        Value::Null => return None,
        other => other.to_string(),
    };
    if text.is_empty() || text == "{}" || text == "[]" {
        return None;
    }
    Some(match text.char_indices().nth(MAX_DETAIL_CHARS) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text,
    })
}

/// The problems of a validation report (`{"field": {"_errors": ["..."]}}`), each with the path of
/// the field it is about.
fn validation_problems(report: &Value, path: &str, found: &mut Vec<String>) {
    let Some(fields) = report.as_object() else {
        return;
    };
    for (key, value) in fields {
        if key == "_errors" {
            for problem in value
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                let line = if path.is_empty() {
                    problem.to_string()
                } else {
                    format!("{path}: {problem}")
                };
                if !found.contains(&line) {
                    found.push(line);
                }
            }
        } else {
            let nested = if path.is_empty() {
                key.clone()
            } else {
                format!("{path}.{key}")
            };
            validation_problems(value, &nested, found);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The error the request `1` ends with when the agent answers `frame`.
    fn answered_with(frame: Value) -> String {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (sender, receiver) = mpsc::channel();
        pending.lock().insert(1, sender);
        dispatch_line(&frame.to_string(), &pending, &|_| {});
        receiver
            .recv()
            .expect("the request was answered")
            .expect_err("the agent answered with an error")
    }

    fn failure(error: Value) -> String {
        answered_with(json!({ "jsonrpc": "2.0", "id": 1, "error": error }))
    }

    #[test]
    fn an_error_without_data_is_just_its_message() {
        assert_eq!(
            failure(json!({ "code": -32002, "message": "session not found" })),
            "session not found"
        );
        assert_eq!(
            failure(json!({ "code": -32603, "message": "Internal error", "data": null })),
            "Internal error"
        );
        assert_eq!(failure(json!({ "code": 1 })), "agent returned an error");
    }

    #[test]
    fn the_cause_an_agent_keeps_in_data_is_not_lost() {
        // Cursor: every unexpected failure is "Internal error"; the cause is in `data`.
        assert_eq!(
            failure(json!({
                "code": -32603,
                "message": "Internal error",
                "data": { "details": "Failed to initialize session services" }
            })),
            "Internal error: Failed to initialize session services"
        );
        assert_eq!(
            failure(json!({
                "code": -32603,
                "message": "Internal error",
                "data": { "message": "Failed to initialize ACP services" }
            })),
            "Internal error: Failed to initialize ACP services"
        );
        assert_eq!(
            failure(json!({ "code": -32000, "message": "Boom", "data": "disk is full" })),
            "Boom: disk is full"
        );
    }

    #[test]
    fn data_that_only_repeats_the_message_adds_nothing() {
        assert_eq!(
            failure(json!({
                "code": -32000,
                "message": "Authentication required",
                "data": { "message": "Authentication required" }
            })),
            "Authentication required"
        );
        assert_eq!(
            failure(json!({ "code": 1, "message": "Boom", "data": {} })),
            "Boom"
        );
    }

    #[test]
    fn a_refused_request_names_the_fields_it_did_not_accept() {
        let text = failure(json!({
            "code": -32602,
            "message": "Invalid params",
            "data": {
                "_errors": [],
                "mcpServers": {
                    "_errors": [],
                    "0": {
                        "_errors": [],
                        "headers": {
                            "_errors": [
                                "Invalid input: expected array, received undefined",
                                "Invalid input: expected array, received undefined"
                            ]
                        }
                    }
                }
            }
        }));
        assert_eq!(
            text,
            "Invalid params: mcpServers.0.headers: Invalid input: expected array, received undefined"
        );
    }

    #[test]
    fn data_of_another_shape_is_shown_as_it_is_and_kept_short() {
        assert_eq!(
            failure(json!({ "code": 1, "message": "Boom", "data": { "retryAfter": 5 } })),
            r#"Boom: {"retryAfter":5}"#
        );
        let long = "x".repeat(MAX_DETAIL_CHARS * 2);
        let text = failure(json!({ "code": 1, "message": "Boom", "data": long }));
        assert_eq!(text.chars().count(), "Boom: ".len() + MAX_DETAIL_CHARS + 1);
        assert!(text.ends_with('…'));
    }

    #[test]
    fn a_result_is_not_an_error() {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (sender, receiver) = mpsc::channel();
        pending.lock().insert(1, sender);
        dispatch_line(r#"{"id":1,"result":{"ok":true}}"#, &pending, &|_| {});
        assert_eq!(
            receiver.recv().expect("answered").expect("a result"),
            json!({ "ok": true })
        );
    }
}
