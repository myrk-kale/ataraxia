//! `AgentRuntime` implementation shared by every provider.
//!
//! The host owns live-session state (status, transcript, active turn, pending
//! permission). Provider specifics live behind [`AgentBackend`].

use std::collections::HashMap;
use std::sync::{Arc, Weak};

use parking_lot::Mutex;
use uuid::Uuid;

use super::backend::{AgentBackend, BackendContext, BackendEvent, BackendSession, SubagentRoute};
use super::registry::ProviderRegistry;
use crate::domain::agent::{CapabilityMatrix, ProviderDescriptor, ProviderKind, SessionOptions};
use crate::domain::ids::{SessionId, TurnId};
use crate::domain::time::now_rfc3339;
use crate::domain::{
    AgentEvent, ChatItem, ChatMessage, ChatRole, ChatSession, ChatSnapshot, Error, ErrorCode,
    PendingPermission, PermissionDecision, Result, SessionStatus, SubagentRecord, SubagentStatus,
    SubagentUpdate, ToolCallRecord, ToolStatus,
};
use crate::ports::{AgentRuntime, EventSink, Store};

struct Live {
    backend: Arc<dyn BackendSession>,
    status: SessionStatus,
    transcript: Vec<ChatItem>,
    subagents: Vec<SubagentRecord>,
    active_turn: Option<TurnId>,
    pending: Option<PendingPermission>,
    /// Leading transcript items from before this agent process started.
    restored_count: usize,
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
            sessions
                .drain()
                .map(|(session_id, live)| {
                    self.inner.persist(session_id, &live.transcript);
                    live.backend
                })
                .collect()
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

    fn persist(&self, session_id: SessionId, transcript: &[ChatItem]) {
        if let Err(error) = self.store.replace_chat_items(session_id, transcript) {
            eprintln!("concierge: could not persist transcript: {error}");
        }
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
            BackendEvent::ToolUpdate {
                turn_id,
                call_id,
                name,
                input,
            } => {
                for item in live.transcript.iter_mut() {
                    if let ChatItem::Tool(tool) = item {
                        if tool.call_id == call_id {
                            if let Some(name) = &name {
                                tool.name = name.clone();
                            }
                            if let Some(input) = &input {
                                tool.input = input.clone();
                            }
                        }
                    }
                }
                self.sink.emit_agent(AgentEvent::ToolUpdate {
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
                self.persist(session_id, &live.transcript);
                self.sink.emit_agent(AgentEvent::TurnDone {
                    session_id,
                    turn_id,
                    ok,
                });
                self.publish_status(session_id, SessionStatus::Ready);
            }
            BackendEvent::Subagent { id, title, update } => {
                apply_subagent(&mut live.subagents, &id, &title, &update);
                self.sink.emit_agent(AgentEvent::Subagent {
                    session_id,
                    subagent_id: id,
                    title,
                    update,
                });
            }
            BackendEvent::Error { message } => {
                let turn = live.active_turn;
                if let Some(turn_id) = turn {
                    finish_turn(live, turn_id, false);
                }
                live.status = SessionStatus::Ready;
                self.persist(session_id, &live.transcript);
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

/// Applies one update to the subagent's own transcript, creating the record on first sight.
fn apply_subagent(
    subagents: &mut Vec<SubagentRecord>,
    id: &str,
    title: &str,
    update: &SubagentUpdate,
) {
    let at = match subagents.iter().position(|item| item.id == id) {
        Some(at) => at,
        None => {
            subagents.push(SubagentRecord {
                id: id.to_string(),
                title: title.to_string(),
                status: SubagentStatus::Running,
                items: Vec::new(),
            });
            subagents.len() - 1
        }
    };
    let record = &mut subagents[at];
    if !title.is_empty() && record.title != title {
        record.title = title.to_string();
    }
    match update {
        SubagentUpdate::Started => record.status = SubagentStatus::Running,
        SubagentUpdate::User { text } => {
            record.status = SubagentStatus::Running;
            record.items.push(ChatItem::Message(ChatMessage {
                id: Uuid::new_v4().to_string(),
                role: ChatRole::User,
                text: text.clone(),
                turn_id: None,
            }));
        }
        SubagentUpdate::Delta { text } => {
            if let Some(ChatItem::Message(last)) = record.items.last_mut() {
                if last.role == ChatRole::Assistant {
                    last.text.push_str(text);
                    return;
                }
            }
            record.items.push(ChatItem::Message(ChatMessage {
                id: Uuid::new_v4().to_string(),
                role: ChatRole::Assistant,
                text: text.clone(),
                turn_id: None,
            }));
        }
        SubagentUpdate::Tool {
            call_id,
            name,
            input,
        } => record.items.push(ChatItem::Tool(ToolCallRecord {
            call_id: *call_id,
            turn_id: TurnId::new(),
            name: name.clone(),
            input: input.clone(),
            output: None,
            status: ToolStatus::Running,
        })),
        SubagentUpdate::ToolResult {
            call_id,
            output,
            ok,
        } => {
            for item in record.items.iter_mut() {
                if let ChatItem::Tool(tool) = item {
                    if tool.call_id == *call_id {
                        tool.output = Some(output.clone());
                        tool.status = if *ok {
                            ToolStatus::Done
                        } else {
                            ToolStatus::Failed
                        };
                    }
                }
            }
        }
        SubagentUpdate::Done { ok } => {
            record.status = if *ok {
                SubagentStatus::Done
            } else {
                SubagentStatus::Failed
            };
            for item in record.items.iter_mut() {
                if let ChatItem::Tool(tool) = item {
                    if tool.status == ToolStatus::Running {
                        tool.status = if *ok {
                            ToolStatus::Done
                        } else {
                            ToolStatus::Failed
                        };
                    }
                }
            }
        }
    }
}

fn finish_turn(live: &mut Live, turn_id: TurnId, ok: bool) {
    // A subagent still open when the turn ends can never report again.
    for record in live
        .subagents
        .iter_mut()
        .filter(|record| record.status == SubagentStatus::Running)
    {
        record.status = if ok {
            SubagentStatus::Done
        } else {
            SubagentStatus::Failed
        };
    }
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

/// A model id is handed to a CLI as an argument, so keep it to plain id characters.
fn clean_model(model: Option<String>) -> Result<Option<String>> {
    let Some(model) = model.map(|value| value.trim().to_string()) else {
        return Ok(None);
    };
    if model.is_empty() {
        return Ok(None);
    }
    let valid = model.len() <= 100
        && model.starts_with(|c: char| c.is_ascii_alphanumeric())
        && model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._:/[]@-".contains(c));
    if valid {
        Ok(Some(model))
    } else {
        Err(Error::new(ErrorCode::Invalid, "invalid model id"))
    }
}

fn clean_effort(provider: ProviderKind, effort: Option<String>) -> Result<Option<String>> {
    let Some(effort) = effort.map(|value| value.trim().to_string()) else {
        return Ok(None);
    };
    if effort.is_empty() {
        return Ok(None);
    }
    let settings = ProviderRegistry::descriptors()
        .into_iter()
        .find(|item| item.kind == provider)
        .map(|item| item.settings)
        .unwrap_or_default();
    // Providers that list their own levels (and per model) are checked by the provider itself.
    let valid = if settings.dynamic {
        effort.len() <= 40
            && effort.starts_with(|c: char| c.is_ascii_alphanumeric())
            && effort
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
    } else {
        settings.efforts.contains(&effort)
    };
    if valid {
        Ok(Some(effort))
    } else {
        Err(Error::new(
            ErrorCode::Invalid,
            format!("{} does not support effort \"{effort}\"", provider.as_str()),
        ))
    }
}

/// Agent names reach a CLI as an argument, so keep them to plain name characters.
fn clean_agent(agent: Option<String>) -> Result<Option<String>> {
    let Some(agent) = agent.map(|value| value.trim().to_string()) else {
        return Ok(None);
    };
    if agent.is_empty() {
        return Ok(None);
    }
    let valid = agent.len() <= 100
        && agent.starts_with(|c: char| c.is_ascii_alphanumeric())
        && agent
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./ ".contains(c));
    if valid {
        Ok(Some(agent))
    } else {
        Err(Error::new(ErrorCode::Invalid, "invalid agent name"))
    }
}

impl AgentHost {
    fn ensure_idle(&self, session_id: &SessionId, what: &str) -> Result<()> {
        let busy = self
            .inner
            .sessions
            .lock()
            .get(session_id)
            .is_some_and(|live| live.active_turn.is_some() || live.pending.is_some());
        if busy {
            return Err(Error::new(
                ErrorCode::Invalid,
                format!("wait for the current turn to finish before {what}"),
            ));
        }
        Ok(())
    }

    /// Stops the live process (keeping the saved transcript) and starts it again.
    fn restart(&self, session_id: &SessionId, session: &ChatSession) -> Result<()> {
        let removed = self.inner.sessions.lock().remove(session_id);
        if let Some(live) = removed {
            self.inner.persist(*session_id, &live.transcript);
            live.backend.shutdown();
        }
        self.start_session(session)
    }

    /// Restarts a provider process that exited since the last turn.
    fn revive_if_dead(&self, session_id: &SessionId) -> Result<()> {
        let dead = self
            .inner
            .sessions
            .lock()
            .get(session_id)
            .is_some_and(|live| !live.backend.is_alive());
        if !dead {
            return Ok(());
        }
        let session = self
            .inner
            .store
            .get_session(*session_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "session not found"))?;
        self.start_session(&session)
    }
}

impl AgentRuntime for AgentHost {
    fn providers(&self) -> Vec<ProviderDescriptor> {
        ProviderRegistry::descriptors()
            .into_iter()
            .filter_map(|mut item| {
                let backend = self.backends.get(&item.kind)?;
                if let Err(reason) = backend.availability() {
                    item.available = false;
                    item.detail = Some(reason);
                }
                Some(item)
            })
            .collect()
    }

    fn capabilities(&self, provider: ProviderKind) -> Result<CapabilityMatrix> {
        ProviderRegistry::capabilities_for(provider)
    }

    fn start_session(&self, session: &ChatSession) -> Result<()> {
        let mut carried = Vec::new();
        let mut carried_subagents = Vec::new();
        {
            let mut sessions = self.inner.sessions.lock();
            if let Some(live) = sessions.get(&session.id) {
                if live.backend.is_alive() {
                    // Already running: just re-sync the UI with the current status.
                    self.inner.sink.emit_agent(AgentEvent::Status {
                        session_id: session.id,
                        status: live.status,
                    });
                    return Ok(());
                }
                // The provider process died: drop the stale session and start a fresh one.
                if let Some(dead) = sessions.remove(&session.id) {
                    dead.backend.shutdown();
                    // Keep what the user already saw; the provider conversation itself restarts.
                    carried = dead.transcript;
                    carried_subagents = dead.subagents;
                }
            }
        }
        if carried.is_empty() {
            carried = self
                .inner
                .store
                .list_chat_items(session.id)
                .unwrap_or_default();
            // A tool that was mid-flight when the app closed can never finish.
            for item in carried.iter_mut() {
                if let ChatItem::Tool(tool) = item {
                    if tool.status == ToolStatus::Running {
                        tool.status = ToolStatus::Failed;
                    }
                }
            }
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
            model: session.model.clone(),
            effort: session.effort.clone(),
            agent: session.agent.clone(),
            emit,
        })?;

        let mut sessions = self.inner.sessions.lock();
        sessions.insert(
            session_id,
            Live {
                backend: started,
                status: SessionStatus::Ready,
                restored_count: carried.len(),
                transcript: carried,
                subagents: carried_subagents,
                active_turn: None,
                pending: None,
            },
        );
        self.inner.publish_status(session_id, SessionStatus::Ready);
        Ok(())
    }

    fn configure_session(
        &self,
        session_id: &SessionId,
        model: Option<String>,
        effort: Option<String>,
        agent: Option<String>,
    ) -> Result<ChatSession> {
        let session = self
            .inner
            .store
            .get_session(*session_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "session not found"))?;
        let descriptor = ProviderRegistry::descriptors()
            .into_iter()
            .find(|item| item.kind == session.provider);
        if !descriptor.is_some_and(|item| item.settings.configurable) {
            return Err(Error::new(
                ErrorCode::Unsupported,
                format!(
                    "{} does not let Concierge change model, effort or agent",
                    session.provider.as_str()
                ),
            ));
        }
        let model = clean_model(model)?;
        let effort = clean_effort(session.provider, effort)?;
        let agent = clean_agent(agent)?;
        self.ensure_idle(session_id, "changing model, effort or agent")?;
        self.inner.store.update_session_settings(
            *session_id,
            model.as_deref(),
            effort.as_deref(),
            agent.as_deref(),
            &now_rfc3339()?,
        )?;
        let updated = self
            .inner
            .store
            .get_session(*session_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "session not found"))?;

        let live_backend = self
            .inner
            .sessions
            .lock()
            .get(session_id)
            .map(|live| Arc::clone(&live.backend));
        if let Some(backend) = live_backend {
            if !backend.apply_settings(model.as_deref(), effort.as_deref(), agent.as_deref()) {
                self.restart(session_id, &updated)?;
            }
        }
        Ok(updated)
    }

    fn switch_provider(
        &self,
        session_id: &SessionId,
        provider: ProviderKind,
    ) -> Result<ChatSession> {
        let session = self
            .inner
            .store
            .get_session(*session_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "session not found"))?;
        if session.provider == provider {
            return Ok(session);
        }
        let backend = self.backends.get(&provider).ok_or_else(|| {
            Error::new(
                ErrorCode::Unsupported,
                format!("provider {} is not available", provider.as_str()),
            )
        })?;
        backend
            .availability()
            .map_err(|reason| Error::new(ErrorCode::Unsupported, reason))?;
        self.ensure_idle(session_id, "switching the harness")?;
        self.inner
            .store
            .update_session_provider(*session_id, provider, &now_rfc3339()?)?;
        let updated = self
            .inner
            .store
            .get_session(*session_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "session not found"))?;
        // The transcript stays on screen; the new harness starts without the old context.
        self.restart(session_id, &updated)?;
        Ok(updated)
    }

    fn message_subagent(
        &self,
        session_id: &SessionId,
        subagent_id: &str,
        text: &str,
    ) -> Result<()> {
        let text = text.trim();
        if text.is_empty() {
            return Err(Error::new(ErrorCode::Invalid, "message is empty"));
        }
        self.revive_if_dead(session_id)?;
        let turn_id = TurnId::new();
        let (backend, previous) = {
            let mut sessions = self.inner.sessions.lock();
            let live = sessions
                .get_mut(session_id)
                .ok_or_else(|| Error::new(ErrorCode::NotFound, "agent session not started"))?;
            if live.active_turn.is_some() || live.pending.is_some() {
                return Err(Error::new(
                    ErrorCode::Invalid,
                    "wait for the current turn to finish before messaging a subagent",
                ));
            }
            if !live.subagents.iter().any(|item| item.id == subagent_id) {
                return Err(Error::new(ErrorCode::NotFound, "subagent not found"));
            }
            // Assume the main agent has to relay it; a direct route hands the turn back below.
            live.active_turn = Some(turn_id);
            live.status = SessionStatus::Working;
            (Arc::clone(&live.backend), live.status)
        };
        let _ = previous;
        self.inner
            .publish_status(*session_id, SessionStatus::Working);
        // The message shows up in the subagent's conversation right away.
        self.inner.handle(
            *session_id,
            BackendEvent::Subagent {
                id: subagent_id.to_string(),
                title: String::new(),
                update: SubagentUpdate::User {
                    text: text.to_string(),
                },
            },
        );
        match backend.message_subagent(turn_id, subagent_id, text) {
            Ok(SubagentRoute::MainTurn) => Ok(()),
            Ok(SubagentRoute::Direct) => {
                let mut sessions = self.inner.sessions.lock();
                if let Some(live) = sessions.get_mut(session_id) {
                    if live.active_turn == Some(turn_id) {
                        live.active_turn = None;
                        live.status = SessionStatus::Ready;
                    }
                }
                drop(sessions);
                self.inner.publish_status(*session_id, SessionStatus::Ready);
                Ok(())
            }
            Err(error) => {
                let mut sessions = self.inner.sessions.lock();
                if let Some(live) = sessions.get_mut(session_id) {
                    if live.active_turn == Some(turn_id) {
                        live.active_turn = None;
                        live.status = SessionStatus::Ready;
                    }
                    if let Some(record) = live
                        .subagents
                        .iter_mut()
                        .find(|item| item.id == subagent_id)
                    {
                        record.status = SubagentStatus::Failed;
                    }
                }
                drop(sessions);
                self.inner.publish_status(*session_id, SessionStatus::Ready);
                Err(error)
            }
        }
    }

    fn session_options(&self, session_id: &SessionId) -> Result<SessionOptions> {
        let backend = self
            .inner
            .sessions
            .lock()
            .get(session_id)
            .map(|live| Arc::clone(&live.backend));
        Ok(backend.map(|backend| backend.options()).unwrap_or_default())
    }

    fn prompt(&self, session_id: &SessionId, text: &str) -> Result<TurnId> {
        let text = text.trim();
        if text.is_empty() {
            return Err(Error::new(ErrorCode::Invalid, "prompt is empty"));
        }
        let turn_id = TurnId::new();
        self.revive_if_dead(session_id)?;
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
            self.inner.persist(*session_id, &live.transcript);
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
                subagents: live.subagents.clone(),
                restored_count: live.restored_count,
                status: live.status,
                pending_permission: live.pending.clone(),
            },
            None => ChatSnapshot {
                items: Vec::new(),
                subagents: Vec::new(),
                restored_count: 0,
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
    use crate::domain::{PermissionRequestId, Repository, ToolCallId, Worktree};

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
        store: Arc<FakeStore>,
        host: AgentHost,
        sink: Arc<RecordingSink>,
        session: ChatSession,
    }

    fn harness() -> Harness {
        harness_with(FakeBackend::new(Duration::ZERO))
    }

    fn harness_with(backend: FakeBackend) -> Harness {
        harness_with_backend(Arc::new(backend))
    }

    fn harness_with_backend(backend: Arc<dyn AgentBackend>) -> Harness {
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
            model: None,
            effort: None,
            agent: None,
            created_at: "t".into(),
            updated_at: "t".into(),
            last_opened_at: None,
        };
        store.create_session(&session).expect("session");
        let sink = Arc::new(RecordingSink::default());
        let host = AgentHost::new(store.clone(), sink.clone())
            .with_backend(ProviderKind::Fake, backend)
            // A second harness to switch to.
            .with_backend(
                ProviderKind::Codex,
                Arc::new(FakeBackend::new(Duration::ZERO)),
            );
        host.start_session(&session).expect("start");
        Harness {
            store,
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
    fn configure_applies_live_without_restarting_the_agent() {
        let h = harness();
        let updated = h
            .host
            .configure_session(
                &h.session.id,
                Some("fake-fast".into()),
                Some("high".into()),
                None,
            )
            .expect("configure");
        assert_eq!(updated.model.as_deref(), Some("fake-fast"));
        assert_eq!(updated.effort.as_deref(), Some("high"));
        let stored = h
            .store
            .get_session(h.session.id)
            .expect("get")
            .expect("some");
        assert_eq!(stored.effort.as_deref(), Some("high"));
        assert_eq!(
            h.host
                .snapshot(&h.session.id)
                .expect("snapshot")
                .restored_count,
            0
        );
    }

    #[test]
    fn configure_restarts_providers_that_read_settings_at_launch() {
        let h = harness_with(FakeBackend::new(Duration::ZERO).restarting_on_settings());
        h.host.prompt(&h.session.id, "hello").expect("prompt");
        h.sink
            .wait_for("permission", |events| pending_request(events).is_some());
        h.host.cancel(&h.session.id, None).expect("cancel");
        h.sink
            .wait_for("turn done", |events| turn_done(events).is_some());
        let before = h
            .host
            .snapshot(&h.session.id)
            .expect("snapshot")
            .items
            .len();
        h.host
            .configure_session(&h.session.id, None, Some("low".into()), None)
            .expect("configure");
        let snapshot = h.host.snapshot(&h.session.id).expect("snapshot");
        assert_eq!(snapshot.items.len(), before, "the transcript is kept");
        assert_eq!(snapshot.restored_count, before, "the agent starts fresh");
    }

    #[test]
    fn configure_rejects_bad_values_and_busy_turns() {
        let h = harness();
        assert!(
            h.host
                .configure_session(&h.session.id, None, Some("turbo".into()), None)
                .is_err()
        );
        assert!(
            h.host
                .configure_session(&h.session.id, Some("--dangerous".into()), None, None)
                .is_err()
        );
        h.host.prompt(&h.session.id, "hello").expect("prompt");
        assert!(
            h.host
                .configure_session(&h.session.id, None, Some("low".into()), None)
                .is_err(),
            "a running turn blocks changes"
        );
    }

    #[test]
    fn switching_harness_keeps_the_transcript_and_resets_provider_specific_settings() {
        let h = harness();
        h.host
            .configure_session(
                &h.session.id,
                Some("fake-fast".into()),
                Some("high".into()),
                Some("reviewer".into()),
            )
            .expect("configure");
        h.host.prompt(&h.session.id, "hello").expect("prompt");
        h.sink
            .wait_for("permission", |events| pending_request(events).is_some());
        h.host.cancel(&h.session.id, None).expect("cancel");
        h.sink
            .wait_for("turn done", |events| turn_done(events).is_some());
        let before = h
            .host
            .snapshot(&h.session.id)
            .expect("snapshot")
            .items
            .len();

        let switched = h
            .host
            .switch_provider(&h.session.id, ProviderKind::Codex)
            .expect("switch");
        assert_eq!(switched.provider, ProviderKind::Codex);
        assert_eq!(
            (switched.model, switched.effort, switched.agent),
            (None, None, None)
        );
        let stored = h
            .store
            .get_session(h.session.id)
            .expect("get")
            .expect("some");
        assert_eq!(stored.provider, ProviderKind::Codex);
        let snapshot = h.host.snapshot(&h.session.id).expect("snapshot");
        assert_eq!(snapshot.items.len(), before);
        assert_eq!(
            snapshot.restored_count, before,
            "the new harness starts fresh"
        );
    }

    #[test]
    fn switching_harness_is_refused_while_busy_or_unavailable() {
        let h = harness();
        assert!(
            h.host
                .switch_provider(&h.session.id, ProviderKind::OpenCode)
                .is_err(),
            "no backend registered for OpenCode"
        );
        h.host.prompt(&h.session.id, "hello").expect("prompt");
        assert!(
            h.host
                .switch_provider(&h.session.id, ProviderKind::Codex)
                .is_err(),
            "a running turn blocks the switch"
        );
        let stored = h
            .store
            .get_session(h.session.id)
            .expect("get")
            .expect("some");
        assert_eq!(stored.provider, ProviderKind::Fake);
    }

    #[test]
    fn agent_names_are_checked_and_stored() {
        let h = harness();
        let updated = h
            .host
            .configure_session(&h.session.id, None, None, Some("code-reviewer".into()))
            .expect("agent");
        assert_eq!(updated.agent.as_deref(), Some("code-reviewer"));
        assert!(
            h.host
                .configure_session(&h.session.id, None, None, Some("--system-prompt".into()))
                .is_err()
        );
        let options = h.host.session_options(&h.session.id).expect("options");
        assert!(options.agents.iter().any(|agent| agent.id == "reviewer"));
    }

    #[test]
    fn subagent_events_build_a_separate_transcript() {
        let h = harness();
        let call_id = ToolCallId::new();
        let send = |update: SubagentUpdate| {
            h.host.inner.handle(
                h.session.id,
                BackendEvent::Subagent {
                    id: "sub-1".into(),
                    title: "Explore".into(),
                    update,
                },
            );
        };
        send(SubagentUpdate::Started);
        send(SubagentUpdate::Delta {
            text: "Look".into(),
        });
        send(SubagentUpdate::Delta { text: "ing".into() });
        send(SubagentUpdate::Tool {
            call_id,
            name: "grep".into(),
            input: "main".into(),
        });
        send(SubagentUpdate::ToolResult {
            call_id,
            output: "3 hits".into(),
            ok: true,
        });
        send(SubagentUpdate::Done { ok: true });

        let snapshot = h.host.snapshot(&h.session.id).expect("snapshot");
        assert!(
            snapshot.items.is_empty(),
            "the main transcript is untouched"
        );
        let [record] = snapshot.subagents.as_slice() else {
            panic!("expected one subagent, got {:?}", snapshot.subagents);
        };
        assert_eq!(record.title, "Explore");
        assert_eq!(record.status, SubagentStatus::Done);
        assert!(matches!(
            &record.items[0],
            ChatItem::Message(message) if message.text == "Looking"
        ));
        assert!(matches!(
            &record.items[1],
            ChatItem::Tool(tool) if tool.status == ToolStatus::Done
                && tool.output.as_deref() == Some("3 hits")
        ));
        let events = h.sink.snapshot();
        assert!(
            events
                .iter()
                .any(|event| matches!(event, AgentEvent::Subagent { subagent_id, .. } if subagent_id == "sub-1"))
        );
    }

    fn seed_subagent(h: &Harness) {
        h.host.inner.handle(
            h.session.id,
            BackendEvent::Subagent {
                id: "sub-1".into(),
                title: "Explore".into(),
                update: SubagentUpdate::Done { ok: true },
            },
        );
    }

    #[test]
    fn a_message_to_a_subagent_lands_in_its_own_conversation_and_gets_an_answer() {
        let h = harness();
        seed_subagent(&h);
        h.host
            .message_subagent(&h.session.id, "sub-1", "  look at the tests  ")
            .expect("message");

        let snapshot = h.host.snapshot(&h.session.id).expect("snapshot");
        assert!(
            snapshot.items.is_empty(),
            "the main conversation is untouched"
        );
        let record = &snapshot.subagents[0];
        assert_eq!(
            record.title, "Explore",
            "an empty title never replaces the real one"
        );
        assert!(matches!(
            &record.items[0],
            ChatItem::Message(message)
                if message.role == ChatRole::User && message.text == "look at the tests"
        ));
        assert!(matches!(
            &record.items[1],
            ChatItem::Message(message) if message.text == "Got it: look at the tests"
        ));
        assert_eq!(record.status, SubagentStatus::Done);
        // A direct route leaves the main agent free for the next prompt.
        assert_eq!(snapshot.status, SessionStatus::Ready);
        h.host
            .prompt(&h.session.id, "next")
            .expect("main agent is free");
    }

    #[test]
    fn messaging_a_subagent_is_refused_when_unknown_empty_or_busy() {
        let h = harness();
        seed_subagent(&h);
        assert!(
            h.host
                .message_subagent(&h.session.id, "nope", "hi")
                .is_err()
        );
        assert!(
            h.host
                .message_subagent(&h.session.id, "sub-1", "   ")
                .is_err()
        );
        h.host.prompt(&h.session.id, "hello").expect("prompt");
        assert!(
            h.host
                .message_subagent(&h.session.id, "sub-1", "hi")
                .is_err(),
            "a running turn blocks it"
        );
    }

    #[test]
    fn a_provider_that_cannot_reach_subagents_reports_why_and_stays_usable() {
        struct Mute;
        impl AgentBackend for Mute {
            fn start(&self, ctx: BackendContext) -> Result<Arc<dyn BackendSession>> {
                FakeBackend::new(Duration::ZERO).start(ctx).map(|inner| {
                    struct Wrapped(Arc<dyn BackendSession>);
                    impl BackendSession for Wrapped {
                        fn prompt(&self, turn_id: TurnId, text: &str) -> Result<()> {
                            self.0.prompt(turn_id, text)
                        }
                        fn cancel(&self) -> Result<()> {
                            self.0.cancel()
                        }
                        fn resolve_permission(&self, decision: &PermissionDecision) -> Result<()> {
                            self.0.resolve_permission(decision)
                        }
                        fn shutdown(&self) {
                            self.0.shutdown()
                        }
                    }
                    Arc::new(Wrapped(inner)) as Arc<dyn BackendSession>
                })
            }
        }
        let h = harness_with_backend(Arc::new(Mute));
        seed_subagent(&h);
        let error = h
            .host
            .message_subagent(&h.session.id, "sub-1", "hi")
            .expect_err("unsupported");
        assert_eq!(error.code, ErrorCode::Unsupported);
        let snapshot = h.host.snapshot(&h.session.id).expect("snapshot");
        assert_eq!(snapshot.status, SessionStatus::Ready);
        h.host.prompt(&h.session.id, "still works").expect("prompt");
    }

    #[test]
    fn a_subagent_left_running_is_closed_when_the_turn_ends() {
        let h = harness();
        h.host.prompt(&h.session.id, "hello").expect("prompt");
        h.sink
            .wait_for("permission", |events| pending_request(events).is_some());
        h.host.inner.handle(
            h.session.id,
            BackendEvent::Subagent {
                id: "sub-1".into(),
                title: "Explore".into(),
                update: SubagentUpdate::Started,
            },
        );
        h.host.cancel(&h.session.id, None).expect("cancel");
        h.sink
            .wait_for("turn done", |events| turn_done(events).is_some());
        let snapshot = h.host.snapshot(&h.session.id).expect("snapshot");
        assert_eq!(snapshot.subagents[0].status, SubagentStatus::Failed);
    }

    #[test]
    fn empty_values_clear_the_override() {
        let h = harness();
        h.host
            .configure_session(
                &h.session.id,
                Some("fake-fast".into()),
                Some("low".into()),
                None,
            )
            .expect("set");
        let cleared = h
            .host
            .configure_session(&h.session.id, Some("  ".into()), None, None)
            .expect("clear");
        assert_eq!(cleared.model, None);
        assert_eq!(cleared.effort, None);
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

    #[test]
    fn finished_turns_are_persisted_and_restored_after_restart() {
        let h = harness();
        h.host.prompt(&h.session.id, "remember me").expect("prompt");
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
        let live_len = h
            .host
            .snapshot(&h.session.id)
            .expect("snapshot")
            .items
            .len();
        assert_eq!(
            h.store.list_chat_items(h.session.id).expect("stored").len(),
            live_len
        );

        // A fresh host (app restart) shows the old transcript, flagged as restored.
        let sink = Arc::new(RecordingSink::default());
        let restarted = AgentHost::new(h.store.clone(), sink).with_backend(
            ProviderKind::Fake,
            Arc::new(FakeBackend::new(Duration::ZERO)),
        );
        restarted.start_session(&h.session).expect("start");
        let snapshot = restarted.snapshot(&h.session.id).expect("snapshot");
        assert_eq!(snapshot.items.len(), live_len);
        assert_eq!(snapshot.restored_count, live_len);
        assert!(matches!(
            &snapshot.items[0],
            ChatItem::Message(m) if m.text == "remember me"
        ));
    }

    #[test]
    fn tools_left_running_on_disk_are_restored_as_failed() {
        let h = harness();
        let turn = TurnId::new();
        h.store
            .replace_chat_items(
                h.session.id,
                &[ChatItem::Tool(ToolCallRecord {
                    call_id: crate::domain::ToolCallId::new(),
                    turn_id: turn,
                    name: "read_file".into(),
                    input: String::new(),
                    output: None,
                    status: ToolStatus::Running,
                })],
            )
            .expect("seed");
        let restarted = AgentHost::new(h.store.clone(), Arc::new(RecordingSink::default()))
            .with_backend(
                ProviderKind::Fake,
                Arc::new(FakeBackend::new(Duration::ZERO)),
            );
        restarted.start_session(&h.session).expect("start");
        let items = restarted.snapshot(&h.session.id).expect("snapshot").items;
        assert!(matches!(&items[0], ChatItem::Tool(t) if t.status == ToolStatus::Failed));
    }
}
