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
                // Dropping the senders wakes every blocked `request` with an error.
                exit_pending.lock().clear();
                exit_handler(Incoming::Closed(info));
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
                Some(error) => Err(error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("agent returned an error")
                    .to_string()),
                None => Ok(frame.get("result").cloned().unwrap_or(Value::Null)),
            };
            let _ = sender.send(outcome);
        }
        (None, None) => {}
    }
}
