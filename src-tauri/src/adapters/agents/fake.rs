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
            read_only: ctx.read_only,
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
    read_only: bool,
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

    fn prompt(&self, turn_id: TurnId, text: &str) -> Result<()> {
        // Tasks the app gives to hidden sessions get a scripted answer in one go, so the
        // whole pipeline can be exercised without a real agent.
        if let Some(answer) = scripted_answer(text, self.read_only) {
            let emit = Arc::clone(&self.emit);
            let delay = self.step_delay;
            thread::spawn(move || {
                thread::sleep(delay);
                emit(BackendEvent::Delta {
                    turn_id,
                    text: answer,
                });
                emit(BackendEvent::TurnDone { turn_id, ok: true });
            });
            return Ok(());
        }
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

/// Canned answers for the app's own prompts (`None` for an ordinary chat message).
fn scripted_answer(text: &str, read_only: bool) -> Option<String> {
    if text.contains("ATARAXIA_TASK:decisions") {
        return Some(
            "```json\n{\"decisions\":[{\"type\":\"behavior\",\"title\":\"Keep the change behind the existing entry point?\",\
\"summary\":\"The change reuses the current entry point instead of adding a new one.\",\
\"context\":\"A new entry point would have duplicated validation.\",\
\"rationale\":\"One place to validate keeps behavior consistent.\",\
\"alternatives\":[{\"title\":\"New entry point\",\"note\":\"More explicit, but duplicates checks.\"}],\
\"files\":[{\"path\":\"README.md\",\"start_line\":1,\"end_line\":3}]},\
{\"type\":\"dependencies\",\"title\":\"Avoid a new dependency\",\"summary\":\"The helper is written locally.\",\
\"files\":[]}]}\n```"
                .to_string(),
        );
    }
    if text.contains("ATARAXIA_TASK:flow") {
        return Some(
            "{\"summary\":\"Request enters, is validated, then stored.\",\"nodes\":[\
{\"id\":\"entry\",\"label\":\"Entry point\",\"kind\":\"entry\",\"description\":\"Receives the request.\",\"refs\":[{\"path\":\"README.md\",\"line\":1}]},\
{\"id\":\"validate\",\"label\":\"Validate\",\"kind\":\"function\",\"description\":\"Checks the input.\",\"refs\":[]},\
{\"id\":\"store\",\"label\":\"Store\",\"kind\":\"data\",\"description\":\"Persists the result.\",\"refs\":[]}],\
\"edges\":[{\"source\":\"entry\",\"target\":\"validate\",\"label\":\"calls\"},{\"source\":\"validate\",\"target\":\"store\",\"label\":\"writes\"}]}"
                .to_string(),
        );
    }
    if text.contains("[fake:actions]") {
        // Does what the question says to the first component of the review queue the prompt lists.
        let first = text
            .lines()
            .skip_while(|line| !line.starts_with("Review queue of"))
            .nth(1)
            .and_then(|line| line.strip_prefix("- "))
            .and_then(|line| {
                let mut parts = line.split(" | ");
                let (_, name, place) = (parts.next()?, parts.next()?, parts.next()?);
                Some((name.to_string(), place.rsplit_once(':')?.0.to_string()))
            });
        let (name, path) = first.unwrap_or_else(|| ("missing".into(), "missing.rs".into()));
        return Some(format!(
            "I commented on {name}, raised it and started the rest.\n\n```ataraxia-actions\n[\
{{\"type\":\"comment\",\"path\":\"{path}\",\"unit\":\"{name}\",\"text\":\"Fake comment on {name}\"}},\
{{\"type\":\"priority\",\"path\":\"{path}\",\"unit\":\"{name}\",\"score\":99,\"reason\":\"fake reason\"}},\
{{\"type\":\"comment\",\"path\":\"{path}\",\"unit\":\"no_such_component\",\"text\":\"lost\"}},\
{{\"type\":\"generate_decisions\",\"focus\":\"retries\"}},\
{{\"type\":\"generate_flow\",\"preset\":\"Execution flow\",\"focus\":\"the entry point\"}}]\n```"
        ));
    }
    read_only
        .then(|| "Here is what I found (fake read-only answer): nothing was modified.".to_string())
}
