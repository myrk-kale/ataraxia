use tauri::{AppHandle, Emitter};

use crate::domain::{AgentEvent, InsightEvent};
use crate::ports::{EventSink, InsightSink};

pub const AGENT_EVENT: &str = "agent://event";
pub const INSIGHT_EVENT: &str = "insight://event";
/// The worktrees or their branches changed under the app (a checkout in a terminal, say).
pub const WORKSPACE_EVENT: &str = "workspace://changed";
/// The files of the selected worktree changed (`{ "worktreeId": ... }`): added, removed,
/// renamed or edited, by git or by anything else.
pub const FILES_EVENT: &str = "worktree://files-changed";

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
            eprintln!("ataraxia: failed to emit agent event: {error}");
        }
    }
}

impl InsightSink for TauriEventSink {
    fn emit_insight(&self, event: InsightEvent) {
        if let Err(error) = self.app.emit(INSIGHT_EVENT, event) {
            eprintln!("ataraxia: failed to emit insight event: {error}");
        }
    }
}
