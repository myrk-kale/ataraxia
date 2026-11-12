//! Deterministic fake agent: text, one tool call that needs approval, then a verdict.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use parking_lot::Mutex;

use super::backend::{
    AgentBackend, BackendContext, BackendEvent, BackendSession, Emitter, SubagentRoute,
};
use crate::domain::agent::{AgentChoice, SessionOptions};
use crate::domain::ids::TurnId;
use crate::domain::{
    Error, ErrorCode, PermissionDecision, PermissionRequestId, Result, SubagentUpdate, ToolCallId,
};

const TOOL_NAME: &str = "read_file";
const TOOL_INPUT: &str = "{\"path\":\"README.md\"}";

pub struct FakeBackend {
    step_delay: Duration,
    live_settings: bool,
}

impl FakeBackend {
    pub fn new(step_delay: Duration) -> Self {
        Self {
            step_delay,
            live_settings: true,
        }
    }

    /// Behaves like providers that only read model/effort at process start (tests).
    pub fn restarting_on_settings(mut self) -> Self {
        self.live_settings = false;
        self
    }
}

impl Default for FakeBackend {
    fn default() -> Self {
        Self::new(Duration::from_millis(60))
    }
}

impl AgentBackend for FakeBackend {
    fn start(&self, ctx: BackendContext) -> Result<Arc<dyn BackendSession>> {
        Ok(Arc::new(FakeSession {
            emit: ctx.emit,
            step_delay: self.step_delay,
            live_settings: self.live_settings,
            state: Arc::new(Mutex::new(FakeState::default())),
        }))
    }
}

#[derive(Default)]
struct FakeState {
    cancel: Option<Arc<AtomicBool>>,
    pending: Option<Pending>,
}

struct Pending {
    turn_id: TurnId,
    request_id: PermissionRequestId,
    call_id: ToolCallId,
}

struct FakeSession {
    emit: Emitter,
    step_delay: Duration,
    live_settings: bool,
    state: Arc<Mutex<FakeState>>,
}

impl BackendSession for FakeSession {
    fn apply_settings(
        &self,
        _model: Option<&str>,
        _effort: Option<&str>,
        _agent: Option<&str>,
    ) -> bool {
        self.live_settings
    }

    fn message_subagent(
        &self,
        _turn_id: TurnId,
        subagent_id: &str,
        text: &str,
    ) -> Result<SubagentRoute> {
        (self.emit)(BackendEvent::Subagent {
            id: subagent_id.to_string(),
            title: String::new(),
            update: SubagentUpdate::Delta {
                text: format!("Got it: {text}"),
            },
        });
        (self.emit)(BackendEvent::Subagent {
            id: subagent_id.to_string(),
            title: String::new(),
            update: SubagentUpdate::Done { ok: true },
        });
        Ok(SubagentRoute::Direct)
    }

    fn options(&self) -> SessionOptions {
        SessionOptions {
            agents: vec![
                AgentChoice {
                    id: "reviewer".into(),
                    label: "reviewer".into(),
                    description: Some("Reviews the change".into()),
                },
                AgentChoice {
                    id: "explorer".into(),
                    label: "explorer".into(),
                    description: None,
                },
            ],
            ..SessionOptions::default()
        }
    }

    fn prompt(&self, turn_id: TurnId, _text: &str) -> Result<()> {
        let cancel = Arc::new(AtomicBool::new(false));
        self.state.lock().cancel = Some(Arc::clone(&cancel));

        let run = TurnRun {
            emit: Arc::clone(&self.emit),
            state: Arc::clone(&self.state),
            delay: self.step_delay,
            turn_id,
            cancel,
        };
        // The scripted turn runs on its own thread so the invoke thread returns immediately.
        thread::spawn(move || run.execute());
        Ok(())
    }

    fn cancel(&self) -> Result<()> {
        let pending = {
            let mut state = self.state.lock();
            if let Some(flag) = state.cancel.as_ref() {
                flag.store(true, Ordering::SeqCst);
            }
            state.pending.take()
        };
        // A turn parked on a permission has no thread to notice the flag.
        if let Some(pending) = pending {
            (self.emit)(BackendEvent::ToolResult {
                turn_id: pending.turn_id,
                call_id: pending.call_id,
                output: "cancelled".into(),
                ok: false,
            });
            (self.emit)(BackendEvent::TurnDone {
                turn_id: pending.turn_id,
                ok: false,
            });
        }
        Ok(())
    }

    fn resolve_permission(&self, decision: &PermissionDecision) -> Result<()> {
        let pending = {
            let mut state = self.state.lock();
            match state.pending.as_ref() {
                Some(pending) if pending.request_id == decision.request_id => {}
                _ => {
                    return Err(Error::new(ErrorCode::Invalid, "no matching permission"));
                }
            }
            state.pending.take().expect("checked above")
        };
        if decision.allow {
            (self.emit)(BackendEvent::ToolResult {
                turn_id: pending.turn_id,
                call_id: pending.call_id,
                output: "README.md (fake contents)".into(),
                ok: true,
            });
            (self.emit)(BackendEvent::Delta {
                turn_id: pending.turn_id,
                text: " Permission granted. README.md looks good.".into(),
            });
            (self.emit)(BackendEvent::TurnDone {
                turn_id: pending.turn_id,
                ok: true,
            });
        } else {
            (self.emit)(BackendEvent::ToolResult {
                turn_id: pending.turn_id,
                call_id: pending.call_id,
                output: "denied by user".into(),
                ok: false,
            });
            (self.emit)(BackendEvent::Delta {
                turn_id: pending.turn_id,
                text: " Permission denied. Stopping.".into(),
            });
            (self.emit)(BackendEvent::TurnDone {
                turn_id: pending.turn_id,
                ok: false,
            });
        }
        Ok(())
    }

    fn shutdown(&self) {
        let _ = self.cancel();
    }
}

struct TurnRun {
    emit: Emitter,
    state: Arc<Mutex<FakeState>>,
    delay: Duration,
    turn_id: TurnId,
    cancel: Arc<AtomicBool>,
}

impl TurnRun {
    fn aborted(&self) -> bool {
        if self.cancel.load(Ordering::SeqCst) {
            (self.emit)(BackendEvent::TurnDone {
                turn_id: self.turn_id,
                ok: false,
            });
            true
        } else {
            false
        }
    }

    fn execute(self) {
        thread::sleep(self.delay);
        if self.aborted() {
            return;
        }
        (self.emit)(BackendEvent::Delta {
            turn_id: self.turn_id,
            text: "I received your request. ".into(),
        });
        thread::sleep(self.delay);
        if self.aborted() {
            return;
        }
        (self.emit)(BackendEvent::Delta {
            turn_id: self.turn_id,
            text: "I need permission to inspect the worktree before continuing.".into(),
        });

        let call_id = ToolCallId::new();
        let request_id = PermissionRequestId::new();
        // Registered under the lock so a concurrent cancel either sees it or aborts us first.
        let mut state = self.state.lock();
        if self.aborted() {
            return;
        }
        state.pending = Some(Pending {
            turn_id: self.turn_id,
            request_id,
            call_id,
        });
        (self.emit)(BackendEvent::Tool {
            turn_id: self.turn_id,
            call_id,
            name: TOOL_NAME.into(),
            input: TOOL_INPUT.into(),
        });
        (self.emit)(BackendEvent::Permission {
            turn_id: self.turn_id,
            request_id,
            tool_name: TOOL_NAME.into(),
            detail: "Allow reading README.md in the selected worktree?".into(),
        });
    }
}
