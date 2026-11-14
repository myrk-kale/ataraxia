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
    /// The number the next agent event is sent with.
    next: std::sync::atomic::AtomicU64,
}

impl TauriEventSink {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            next: std::sync::atomic::AtomicU64::new(1),
        }
    }
}

/// An agent event with its place in the order the app sent them. The window ignores a number it
/// has already seen, so an event that reaches it twice (a listener left over from a hot reload,
/// say) is applied once, and streamed text is never doubled.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Stamped {
    pub seq: u64,
    #[serde(flatten)]
    pub event: AgentEvent,
}

impl EventSink for TauriEventSink {
    fn emit_agent(&self, event: AgentEvent) {
        let seq = self.next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if let Err(error) = self.app.emit(AGENT_EVENT, Stamped { seq, event }) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::ids::{SessionId, TurnId};
    use crate::domain::{ChatRole, SessionStatus};

    #[test]
    fn an_event_goes_out_with_its_number_beside_its_own_fields() {
        let session = SessionId::new();
        let stamped = Stamped {
            seq: 7,
            event: AgentEvent::Delta {
                session_id: session,
                turn_id: TurnId::new(),
                role: ChatRole::Assistant,
                text: "hi".into(),
                images: Vec::new(),
            },
        };
        let json = serde_json::to_value(&stamped).expect("serialize");
        assert_eq!(json["seq"], 7);
        assert_eq!(json["type"], "delta");
        assert_eq!(json["text"], "hi");
        assert_eq!(json["role"], "assistant");
        assert_eq!(json["sessionId"], session.0.to_string());
    }

    #[test]
    fn every_kind_of_event_can_carry_a_number() {
        let session = SessionId::new();
        for event in [
            AgentEvent::Status {
                session_id: session,
                status: SessionStatus::Ready,
            },
            AgentEvent::TurnDone {
                session_id: session,
                turn_id: TurnId::new(),
                ok: true,
            },
        ] {
            let json = serde_json::to_value(Stamped { seq: 1, event }).expect("serialize");
            assert_eq!(json["seq"], 1);
            assert!(json["type"].is_string());
        }
    }
}
