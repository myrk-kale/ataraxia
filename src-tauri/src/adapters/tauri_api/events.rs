use tauri::{AppHandle, Emitter};

use crate::domain::AgentEvent;
use crate::ports::EventSink;

pub const AGENT_EVENT: &str = "agent://event";

pub struct TauriEventSink {
    app: AppHandle,
}

impl TauriEventSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl EventSink for TauriEventSink {
    fn emit_agent(&self, event: AgentEvent) {
        if let Err(error) = self.app.emit(AGENT_EVENT, event) {
            eprintln!("concierge: failed to emit agent event: {error}");
        }
    }
}
