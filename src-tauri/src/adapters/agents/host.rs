//! `AgentRuntime` implementation shared by every provider.
//!
//! The host owns live-session state (status, transcript, active turn, pending
//! permission). Provider specifics live behind [`AgentBackend`].

use std::collections::HashMap;
use std::sync::{Arc, Weak};

use parking_lot::Mutex;
use uuid::Uuid;

use super::backend::{AgentBackend, BackendContext, BackendEvent, BackendSession};
use super::registry::ProviderRegistry;
use crate::domain::agent::{CapabilityMatrix, ProviderDescriptor, ProviderKind};
use crate::domain::ids::{SessionId, TurnId};
use crate::domain::time::now_rfc3339;
use crate::domain::{
    AgentEvent, ChatItem, ChatMessage, ChatRole, ChatSession, ChatSnapshot, Error, ErrorCode,
    PendingPermission, PermissionDecision, Result, SessionStatus, ToolCallRecord, ToolStatus,
};
use crate::ports::{AgentRuntime, EventSink, Store};

struct Live {
    backend: Arc<dyn BackendSession>,
    status: SessionStatus,
    transcript: Vec<ChatItem>,
    active_turn: Option<TurnId>,
    pending: Option<PendingPermission>,
}

struct Inner {
    store: Arc<dyn Store>,
    sink: Arc<dyn EventSink>,
    sessions: Mutex<HashMap<SessionId, Live>>,
}

pub struct AgentHost {
    inner: Arc<Inner>,
    backends: HashMap<ProviderKind, Arc<dyn AgentBackend>>,
}

impl AgentHost {
    pub fn new(store: Arc<dyn Store>, sink: Arc<dyn EventSink>) -> Self {
        Self {
            inner: Arc::new(Inner {
                store,
                sink,
                sessions: Mutex::new(HashMap::new()),
            }),
            backends: HashMap::new(),
        }
    }

    pub fn with_backend(mut self, kind: ProviderKind, backend: Arc<dyn AgentBackend>) -> Self {
        self.backends.insert(kind, backend);
        self
    }

    pub fn shutdown_all(&self) {
        let backends: Vec<_> = {
            let mut sessions = self.inner.sessions.lock();
            sessions.drain().map(|(_, live)| live.backend).collect()
        };
        for backend in backends {
            backend.shutdown();
        }
    }
}

impl Inner {
    /// Persist + emit a status change. Caller holds the sessions lock so event order is stable.
    fn publish_status(&self, session_id: SessionId, status: SessionStatus) {
        match now_rfc3339() {
            Ok(updated_at) => {
                if let Err(error) =
                    self.store
                        .update_session_status(session_id, status, &updated_at)
                {
                    eprintln!("concierge: could not persist session status: {error}");
                }
            }
            Err(error) => eprintln!("concierge: clock error: {error}"),
        }
        self.sink
            .emit_agent(AgentEvent::Status { session_id, status });
    }

    fn handle(&self, session_id: SessionId, event: BackendEvent) {
        let mut sessions = self.sessions.lock();
        let Some(live) = sessions.get_mut(&session_id) else {
            return;
        };
        match event {
            BackendEvent::Delta { turn_id, text } => {
                if live.active_turn != Some(turn_id) {
                    return;
                }
                append_text(&mut live.transcript, ChatRole::Assistant, turn_id, &text);
                self.sink.emit_agent(AgentEvent::Delta {
                    session_id,
                    turn_id,
                    role: ChatRole::Assistant,
                    text,
                });
            }
            BackendEvent::Tool {
                turn_id,
                call_id,
                name,
                input,
            } => {
                if live.active_turn != Some(turn_id) {
                    return;
                }
                live.transcript.push(ChatItem::Tool(ToolCallRecord {
                    call_id,
                    turn_id,
                    name: name.clone(),
                    input: input.clone(),
                    output: None,
                    status: ToolStatus::Running,
                }));
                self.sink.emit_agent(AgentEvent::Tool {
                    session_id,
                    turn_id,
                    call_id,
                    name,
                    input,
                });
            }
            BackendEvent::ToolResult {
                turn_id,
                call_id,
                output,
                ok,
            } => {
                for item in live.transcript.iter_mut() {
                    if let ChatItem::Tool(tool) = item {
                        if tool.call_id == call_id {
                            tool.output = Some(output.clone());
                            tool.status = if ok {
                                ToolStatus::Done
                            } else {
                                ToolStatus::Failed
                            };
                        }
                    }
                }
                self.sink.emit_agent(AgentEvent::ToolResult {
                    session_id,
                    turn_id,
                    call_id,
                    output,
                    ok,
                });
            }
            BackendEvent::Permission {
                turn_id,
                request_id,
                tool_name,
                detail,
            } => {
                if live.active_turn != Some(turn_id) {
                    return;
                }
                live.pending = Some(PendingPermission {
                    request_id,
                    turn_id,
                    tool_name: tool_name.clone(),
                    detail: detail.clone(),
                });
                live.status = SessionStatus::WaitingPermission;
                self.sink.emit_agent(AgentEvent::Permission {
                    session_id,
                    turn_id,
                    request_id,
                    tool_name,
                    detail,
                });
                self.publish_status(session_id, SessionStatus::WaitingPermission);
            }
            BackendEvent::TurnDone { turn_id, ok } => {
                if live.active_turn != Some(turn_id) {
                    return;
                }
                finish_turn(live, turn_id, ok);
                self.sink.emit_agent(AgentEvent::TurnDone {
                    session_id,
                    turn_id,
                    ok,
                });
                self.publish_status(session_id, SessionStatus::Ready);
            }
            BackendEvent::Error { message } => {
                let turn = live.active_turn;
                if let Some(turn_id) = turn {
                    finish_turn(live, turn_id, false);
                }
                live.status = SessionStatus::Ready;
                self.sink.emit_agent(AgentEvent::Error {
                    session_id,
                    message,
                });
                if let Some(turn_id) = turn {
                    self.sink.emit_agent(AgentEvent::TurnDone {
                        session_id,
                        turn_id,
                        ok: false,
                    });
                }
                self.publish_status(session_id, SessionStatus::Ready);
            }
        }
    }
}

fn append_text(transcript: &mut Vec<ChatItem>, role: ChatRole, turn_id: TurnId, text: &str) {
    if let Some(ChatItem::Message(last)) = transcript.last_mut() {
        if last.role == role && last.turn_id == Some(turn_id) {
            last.text.push_str(text);
            return;
        }
    }
    transcript.push(ChatItem::Message(ChatMessage {
        id: Uuid::new_v4().to_string(),
        role,
        text: text.to_string(),
        turn_id: Some(turn_id),
    }));
}

fn finish_turn(live: &mut Live, turn_id: TurnId, ok: bool) {
    for item in live.transcript.iter_mut() {
        if let ChatItem::Tool(tool) = item {
            if tool.turn_id == turn_id && tool.status == ToolStatus::Running {
                tool.status = if ok {
                    ToolStatus::Done
                } else {
                    ToolStatus::Failed
                };
            }
        }
    }
    live.active_turn = None;
    live.pending = None;
    live.status = SessionStatus::Ready;
}

impl AgentRuntime for AgentHost {
    fn providers(&self) -> Vec<ProviderDescriptor> {
        ProviderRegistry::descriptors()
            .into_iter()
            .filter(|item| self.backends.contains_key(&item.kind))
            .collect()
    }

    fn capabilities(&self, provider: ProviderKind) -> Result<CapabilityMatrix> {
        ProviderRegistry::capabilities_for(provider)
    }

    fn start_session(&self, session: &ChatSession) -> Result<()> {
        if let Some(live) = self.inner.sessions.lock().get(&session.id) {
            // Already running: just re-sync the UI with the current status.
            self.inner.sink.emit_agent(AgentEvent::Status {
                session_id: session.id,
                status: live.status,
            });
            return Ok(());
        }
        let backend = self.backends.get(&session.provider).ok_or_else(|| {
            Error::new(
                ErrorCode::Unsupported,
                format!("provider {} is not available", session.provider.as_str()),
            )
        })?;
        let worktree = self
            .inner
            .store
            .get_worktree(session.worktree_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "worktree not found"))?;

        let weak: Weak<Inner> = Arc::downgrade(&self.inner);
        let session_id = session.id;
        let emit = Arc::new(move |event: BackendEvent| {
            if let Some(inner) = weak.upgrade() {
                inner.handle(session_id, event);
            }
        });
        let started = backend.start(BackendContext {
            session_id,
            cwd: worktree.path,
            emit,
        })?;

        let mut sessions = self.inner.sessions.lock();
        sessions.insert(
            session_id,
            Live {
                backend: started,
                status: SessionStatus::Ready,
                transcript: Vec::new(),
                active_turn: None,
                pending: None,
            },
        );
        self.inner.publish_status(session_id, SessionStatus::Ready);
        Ok(())
    }

    fn prompt(&self, session_id: &SessionId, text: &str) -> Result<TurnId> {
        let text = text.trim();
        if text.is_empty() {
            return Err(Error::new(ErrorCode::Invalid, "prompt is empty"));
        }
        let turn_id = TurnId::new();
        let backend = {
            let mut sessions = self.inner.sessions.lock();
            let live = sessions
                .get_mut(session_id)
                .ok_or_else(|| Error::new(ErrorCode::NotFound, "agent session not started"))?;
            if live.active_turn.is_some() {
                return Err(Error::new(ErrorCode::Invalid, "a turn is already running"));
            }
            live.active_turn = Some(turn_id);
            live.status = SessionStatus::Working;
            append_text(&mut live.transcript, ChatRole::User, turn_id, text);
            self.inner.sink.emit_agent(AgentEvent::Delta {
                session_id: *session_id,
                turn_id,
                role: ChatRole::User,
                text: text.to_string(),
            });
            self.inner
                .publish_status(*session_id, SessionStatus::Working);
            Arc::clone(&live.backend)
        };

        if let Err(error) = backend.prompt(turn_id, text) {
            self.inner.handle(
                *session_id,
                BackendEvent::Error {
                    message: error.message.clone(),
                },
            );
            return Err(error);
        }
        Ok(turn_id)
    }

    fn cancel(&self, session_id: &SessionId, _turn_id: Option<&TurnId>) -> Result<()> {
        let backend = {
            let sessions = self.inner.sessions.lock();
            let live = sessions
                .get(session_id)
                .ok_or_else(|| Error::new(ErrorCode::NotFound, "agent session not started"))?;
            if live.active_turn.is_none() {
                return Ok(());
            }
            Arc::clone(&live.backend)
        };
        backend.cancel()
    }

    fn resolve_permission(
        &self,
        session_id: &SessionId,
        decision: PermissionDecision,
    ) -> Result<()> {
        let backend = {
            let mut sessions = self.inner.sessions.lock();
            let live = sessions
                .get_mut(session_id)
                .ok_or_else(|| Error::new(ErrorCode::NotFound, "agent session not started"))?;
            match &live.pending {
                Some(pending) if pending.request_id == decision.request_id => {}
                Some(_) => {
                    return Err(Error::new(
                        ErrorCode::Invalid,
                        "permission request does not match the pending one",
                    ));
                }
                None => {
                    return Err(Error::new(ErrorCode::Invalid, "no pending permission"));
                }
            }
            live.pending = None;
            live.status = SessionStatus::Working;
            self.inner
                .publish_status(*session_id, SessionStatus::Working);
            Arc::clone(&live.backend)
        };
        backend.resolve_permission(&decision)
    }

    fn snapshot(&self, session_id: &SessionId) -> Result<ChatSnapshot> {
        let sessions = self.inner.sessions.lock();
        Ok(match sessions.get(session_id) {
            Some(live) => ChatSnapshot {
                items: live.transcript.clone(),
                status: live.status,
                pending_permission: live.pending.clone(),
            },
            None => ChatSnapshot {
                items: Vec::new(),
                status: SessionStatus::Idle,
                pending_permission: None,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    use super::*;
    use crate::adapters::agents::FakeBackend;
    use crate::app::fakes::FakeStore;
    use crate::domain::ids::{RepositoryId, WorktreeId};
    use crate::domain::{PermissionRequestId, Repository, Worktree};

    #[derive(Default)]
    struct RecordingSink {
        events: Mutex<Vec<AgentEvent>>,
    }

    impl EventSink for RecordingSink {
        fn emit_agent(&self, event: AgentEvent) {
            self.events.lock().push(event);
        }
    }

    impl RecordingSink {
        fn snapshot(&self) -> Vec<AgentEvent> {
            self.events.lock().clone()
        }

        fn wait_for(&self, what: &str, predicate: impl Fn(&[AgentEvent]) -> bool) {
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline {
                if predicate(&self.snapshot()) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            panic!("timed out waiting for {what}: {:?}", self.snapshot());
        }
    }

    struct Harness {
        host: AgentHost,
        sink: Arc<RecordingSink>,
        session: ChatSession,
    }

    fn harness() -> Harness {
        let store = Arc::new(FakeStore::healthy());
        let repository_id = RepositoryId::new();
        let worktree_id = WorktreeId::new();
        store
            .upsert_repository(&Repository {
                id: repository_id,
                root: PathBuf::from("/tmp/repo"),
                name: "repo".into(),
                created_at: "t".into(),
                updated_at: "t".into(),
            })
            .expect("repo");
        store
            .upsert_worktree(&Worktree {
                id: worktree_id,
                repository_id,
                path: PathBuf::from("/tmp/repo"),
                branch: None,
                head: None,
                created_at: "t".into(),
                updated_at: "t".into(),
            })
            .expect("worktree");
        let session = ChatSession {
            id: SessionId::new(),
            repository_id,
            worktree_id,
            provider: ProviderKind::Fake,
            title: "Chat".into(),
            status: SessionStatus::Idle,
            created_at: "t".into(),
            updated_at: "t".into(),
            last_opened_at: None,
        };
        store.create_session(&session).expect("session");
        let sink = Arc::new(RecordingSink::default());
        let host = AgentHost::new(store, sink.clone()).with_backend(
            ProviderKind::Fake,
            Arc::new(FakeBackend::new(Duration::ZERO)),
        );
        host.start_session(&session).expect("start");
        Harness {
            host,
            sink,
            session,
        }
    }

    fn pending_request(events: &[AgentEvent]) -> Option<PermissionRequestId> {
        events.iter().find_map(|event| match event {
            AgentEvent::Permission { request_id, .. } => Some(*request_id),
            _ => None,
        })
    }

    fn turn_done(events: &[AgentEvent]) -> Option<bool> {
        events.iter().find_map(|event| match event {
            AgentEvent::TurnDone { ok, .. } => Some(*ok),
            _ => None,
        })
    }

    #[test]
    fn prompt_streams_then_waits_for_permission() {
        let h = harness();
        h.host.prompt(&h.session.id, "hello").expect("prompt");
        h.sink
            .wait_for("permission", |events| pending_request(events).is_some());
        let events = h.sink.snapshot();
        assert!(events.iter().any(|event| matches!(
            event,
            AgentEvent::Status {
                status: SessionStatus::WaitingPermission,
                ..
            }
        )));
        let transcript = h.host.snapshot(&h.session.id).expect("snapshot").items;
        assert!(matches!(&transcript[0], ChatItem::Message(m) if m.role == ChatRole::User));
        assert!(matches!(&transcript[1], ChatItem::Message(m) if m.role == ChatRole::Assistant));
        assert!(matches!(&transcript[2], ChatItem::Tool(t) if t.status == ToolStatus::Running));
    }

    #[test]
    fn approving_finishes_the_turn() {
        let h = harness();
        h.host.prompt(&h.session.id, "hello").expect("prompt");
        h.sink
            .wait_for("permission", |events| pending_request(events).is_some());
        let request_id = pending_request(&h.sink.snapshot()).expect("request");
        h.host
            .resolve_permission(
                &h.session.id,
                PermissionDecision {
                    request_id,
                    allow: true,
                },
            )
            .expect("resolve");
        h.sink
            .wait_for("turn done", |events| turn_done(events).is_some());
        assert_eq!(turn_done(&h.sink.snapshot()), Some(true));
        let transcript = h.host.snapshot(&h.session.id).expect("snapshot").items;
        assert!(
            transcript
                .iter()
                .any(|item| matches!(item, ChatItem::Tool(t) if t.status == ToolStatus::Done))
        );
        // A new turn can start afterwards.
        h.host
            .prompt(&h.session.id, "again")
            .expect("second prompt");
    }

    #[test]
    fn denying_marks_tool_failed() {
        let h = harness();
        h.host.prompt(&h.session.id, "hello").expect("prompt");
        h.sink
            .wait_for("permission", |events| pending_request(events).is_some());
        let request_id = pending_request(&h.sink.snapshot()).expect("request");
        h.host
            .resolve_permission(
                &h.session.id,
                PermissionDecision {
                    request_id,
                    allow: false,
                },
            )
            .expect("resolve");
        h.sink
            .wait_for("turn done", |events| turn_done(events).is_some());
        assert_eq!(turn_done(&h.sink.snapshot()), Some(false));
        let transcript = h.host.snapshot(&h.session.id).expect("snapshot").items;
        assert!(
            transcript
                .iter()
                .any(|item| matches!(item, ChatItem::Tool(t) if t.status == ToolStatus::Failed))
        );
    }

    #[test]
    fn cancel_while_waiting_ends_the_turn() {
        let h = harness();
        h.host.prompt(&h.session.id, "hello").expect("prompt");
        h.sink
            .wait_for("permission", |events| pending_request(events).is_some());
        h.host.cancel(&h.session.id, None).expect("cancel");
        h.sink
            .wait_for("turn done", |events| turn_done(events).is_some());
        assert_eq!(turn_done(&h.sink.snapshot()), Some(false));
        assert!(h.host.prompt(&h.session.id, "next").is_ok());
    }

    #[test]
    fn rejects_overlapping_prompts_and_wrong_request_ids() {
        let h = harness();
        h.host.prompt(&h.session.id, "one").expect("prompt");
        let error = h.host.prompt(&h.session.id, "two").expect_err("overlap");
        assert_eq!(error.code, ErrorCode::Invalid);
        h.sink
            .wait_for("permission", |events| pending_request(events).is_some());
        let error = h
            .host
            .resolve_permission(
                &h.session.id,
                PermissionDecision {
                    request_id: PermissionRequestId::new(),
                    allow: true,
                },
            )
            .expect_err("mismatch");
        assert_eq!(error.code, ErrorCode::Invalid);
    }

    #[test]
    fn unavailable_provider_is_unsupported() {
        let h = harness();
        let mut other = h.session.clone();
        other.id = SessionId::new();
        other.provider = ProviderKind::Claude;
        let error = h.host.start_session(&other).expect_err("unsupported");
        assert_eq!(error.code, ErrorCode::Unsupported);
    }
}
