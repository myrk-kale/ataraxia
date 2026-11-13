//! `AgentRuntime` implementation shared by every provider.
//!
//! The host owns live-session state (status, transcript, active turn, pending
//! permission). Provider specifics live behind [`AgentBackend`].

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Weak};

use parking_lot::Mutex;
use uuid::Uuid;

use super::backend::{AgentBackend, BackendContext, BackendEvent, BackendSession, SubagentRoute};
use super::registry::ProviderRegistry;
use super::{guide, handoff};
use crate::domain::agent::{CapabilityMatrix, ProviderDescriptor, ProviderKind, SessionOptions};
use crate::domain::ids::{SessionId, TurnId};
use crate::domain::time::now_rfc3339;
use crate::domain::{
    AgentEvent, ChatItem, ChatMessage, ChatRole, ChatSession, ChatSnapshot, Error, ErrorCode,
    PendingPermission, PermissionDecision, Result, SessionStatus, SubagentRecord, SubagentStatus,
    SubagentUpdate, ToolCallRecord, ToolStatus,
};
use crate::ports::{AgentRuntime, ApiGateway, EventSink, InsightStore, Store};

struct Live {
    backend: Arc<dyn BackendSession>,
    status: SessionStatus,
    transcript: Vec<ChatItem>,
    subagents: Vec<SubagentRecord>,
    active_turn: Option<TurnId>,
    pending: Option<PendingPermission>,
    /// Leading transcript items from before this agent process started.
    restored_count: usize,
    /// Investigation-only session: every permission request is refused.
    read_only: bool,
    /// A chat of the developer's own (not a hidden helper): the one that is told about Ataraxia.
    chat: bool,
    /// Whether this agent process has been told about Ataraxia yet.
    introduced: bool,
    /// The local API token this process runs with, revoked when the process is retired.
    api_token: Option<String>,
}

/// A conversation that is shown as a subagent of another chat.
#[derive(Clone)]
struct Link {
    parent: SessionId,
    title: String,
}

struct Inner {
    store: Arc<dyn Store>,
    insights: Option<Arc<dyn InsightStore>>,
    sink: Arc<dyn EventSink>,
    sessions: Mutex<HashMap<SessionId, Live>>,
    /// Child session to the chat it is a subagent of (BTW conversations).
    links: Mutex<HashMap<SessionId, Link>>,
    /// Where the record of a chat is written when its harness is switched.
    handoff_dir: Mutex<Option<PathBuf>>,
    /// Chats whose next prompt must tell the new agent about the record (the file's path).
    handoffs: Mutex<HashMap<SessionId, PathBuf>>,
    /// The page of the guide that a chat's agent is pointed at, when there is one.
    guide: Mutex<Option<PathBuf>>,
    /// Issues the local API tokens that agent processes start with.
    api: Mutex<Option<Arc<dyn ApiGateway>>>,
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
                insights: None,
                sink,
                sessions: Mutex::new(HashMap::new()),
                links: Mutex::new(HashMap::new()),
                handoff_dir: Mutex::new(None),
                handoffs: Mutex::new(HashMap::new()),
                guide: Mutex::new(None),
                api: Mutex::new(None),
            }),
            backends: HashMap::new(),
        }
    }

    /// The page of the guide to point each chat's agent at (see `guide::install`).
    pub fn with_guide(self, index: PathBuf) -> Self {
        *self.inner.guide.lock() = Some(index);
        self
    }

    /// Gives every agent process a token for the local API, revoked when the process goes.
    pub fn with_api(self, api: Arc<dyn ApiGateway>) -> Self {
        *self.inner.api.lock() = Some(api);
        self
    }

    /// Where to write the conversation when the user switches a chat to another harness.
    pub fn with_handoff_dir(self, dir: PathBuf) -> Self {
        *self.inner.handoff_dir.lock() = Some(dir);
        self
    }

    /// Lets the host keep subagent conversations across restarts.
    pub fn with_insights(mut self, insights: Arc<dyn InsightStore>) -> Self {
        if let Some(inner) = Arc::get_mut(&mut self.inner) {
            inner.insights = Some(insights);
        }
        self
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
                    self.inner.persist_subagents(session_id, &live.subagents);
                    (live.backend, live.api_token)
                })
                .collect()
        };
        for (backend, token) in backends {
            backend.shutdown();
            self.inner.revoke(token.as_deref());
        }
    }
}

impl Inner {
    /// Stops a live agent process and takes its API token away.
    fn retire(&self, live: &Live) {
        live.backend.shutdown();
        self.revoke(live.api_token.as_deref());
    }

    fn revoke(&self, token: Option<&str>) {
        let Some(token) = token else { return };
        if let Some(api) = self.api.lock().clone() {
            api.revoke(token);
        }
    }

    /// Persist + emit a status change. Caller holds the sessions lock so event order is stable.
    fn publish_status(&self, session_id: SessionId, status: SessionStatus) {
        match now_rfc3339() {
            Ok(updated_at) => {
                if let Err(error) =
                    self.store
                        .update_session_status(session_id, status, &updated_at)
                {
                    eprintln!("ataraxia: could not persist session status: {error}");
                }
            }
            Err(error) => eprintln!("ataraxia: clock error: {error}"),
        }
        self.sink
            .emit_agent(AgentEvent::Status { session_id, status });
    }

    fn persist(&self, session_id: SessionId, transcript: &[ChatItem]) {
        if let Err(error) = self.store.replace_chat_items(session_id, transcript) {
            eprintln!("ataraxia: could not persist transcript: {error}");
        }
    }

    fn persist_subagents(&self, session_id: SessionId, subagents: &[SubagentRecord]) {
        if let Some(insights) = &self.insights {
            if let Err(error) = insights.replace_subagents(session_id, subagents) {
                eprintln!("ataraxia: could not persist subagents: {error}");
            }
        }
    }

    /// What a linked conversation's event looks like from its parent chat: one update of the subagent.
    fn mirrored(
        &self,
        session_id: SessionId,
        event: &BackendEvent,
    ) -> Option<(Link, SubagentUpdate)> {
        let link = self.links.lock().get(&session_id)?.clone();
        let update = match event {
            BackendEvent::Delta { text, .. } => SubagentUpdate::Delta { text: text.clone() },
            BackendEvent::Tool {
                call_id,
                name,
                input,
                ..
            } => SubagentUpdate::Tool {
                call_id: *call_id,
                name: name.clone(),
                input: input.clone(),
            },
            BackendEvent::ToolResult {
                call_id,
                output,
                ok,
                ..
            } => SubagentUpdate::ToolResult {
                call_id: *call_id,
                output: output.clone(),
                ok: *ok,
            },
            BackendEvent::TurnDone { ok, .. } => SubagentUpdate::Done { ok: *ok },
            BackendEvent::Error { .. } => SubagentUpdate::Done { ok: false },
            _ => return None,
        };
        Some((link, update))
    }

    /// The conversation that is the subagent `id` of `parent`, if it is one: a BTW conversation,
    /// live in this run or found in the store after a restart.
    fn linked_child(&self, parent: &SessionId, id: &str) -> Option<SessionId> {
        let child = SessionId(Uuid::parse_str(id).ok()?);
        if self
            .links
            .lock()
            .get(&child)
            .is_some_and(|link| link.parent == *parent)
        {
            return Some(child);
        }
        let session = self.store.get_session(child).ok()??;
        (session.parent_session_id == Some(*parent)
            && matches!(
                session.kind,
                crate::domain::SessionKind::Btw | crate::domain::SessionKind::Delegate
            ))
        .then_some(child)
    }

    fn handle(&self, session_id: SessionId, event: BackendEvent) {
        let mirrored = self.mirrored(session_id, &event);
        self.handle_event(session_id, event);
        if let Some((link, update)) = mirrored {
            self.handle_event(
                link.parent,
                BackendEvent::Subagent {
                    id: session_id.0.to_string(),
                    title: link.title,
                    update,
                },
            );
        }
    }

    fn handle_event(&self, session_id: SessionId, event: BackendEvent) {
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
                if live.read_only {
                    // Investigations never write: refuse without bothering the user.
                    let backend = Arc::clone(&live.backend);
                    std::thread::spawn(move || {
                        let _ = backend.resolve_permission(&PermissionDecision {
                            request_id,
                            allow: false,
                        });
                    });
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
                self.persist_subagents(session_id, &live.subagents);
                self.sink.emit_agent(AgentEvent::TurnDone {
                    session_id,
                    turn_id,
                    ok,
                });
                self.publish_status(session_id, SessionStatus::Ready);
            }
            BackendEvent::TurnStarted { turn_id } => {
                if live.active_turn.is_none() {
                    live.active_turn = Some(turn_id);
                    live.status = SessionStatus::Working;
                    self.publish_status(session_id, SessionStatus::Working);
                }
            }
            BackendEvent::Subagent { id, title, update } => {
                apply_subagent(&mut live.subagents, &id, &title, &update);
                if matches!(
                    update,
                    SubagentUpdate::Done { .. } | SubagentUpdate::Detached
                ) {
                    self.persist_subagents(session_id, &live.subagents);
                }
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
                detached: false,
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
        SubagentUpdate::Detached => {
            record.status = SubagentStatus::Running;
            record.detached = true;
        }
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
            record.detached = false;
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
    // A subagent still open when the turn ends can never report again, unless it was
    // launched in the background and is meant to outlive the turn.
    for record in live
        .subagents
        .iter_mut()
        .filter(|record| record.status == SubagentStatus::Running && !record.detached)
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
            self.inner.retire(&live);
        }
        self.start_session(session)
    }

    /// Saves the whole conversation as text for the harness that takes over. Failing to write it
    /// never blocks the switch; the new agent just is not pointed at a record.
    fn write_handoff(&self, session_id: &SessionId, from: ProviderKind) {
        let Some(dir) = self.inner.handoff_dir.lock().clone() else {
            return;
        };
        let (items, subagents) = {
            let sessions = self.inner.sessions.lock();
            match sessions.get(session_id) {
                Some(live) => (live.transcript.clone(), live.subagents.clone()),
                None => (
                    self.inner
                        .store
                        .list_chat_items(*session_id)
                        .unwrap_or_default(),
                    self.inner
                        .insights
                        .as_ref()
                        .and_then(|insights| insights.list_subagents(*session_id).ok())
                        .unwrap_or_default(),
                ),
            }
        };
        if items.is_empty() && subagents.is_empty() {
            return;
        }
        let path = handoff::handoff_path(&dir, session_id);
        let text = handoff::render(from.as_str(), &items, &subagents);
        match handoff::write(&path, &text) {
            Ok(()) => {
                self.inner.handoffs.lock().insert(*session_id, path);
            }
            Err(error) => eprintln!("ataraxia: could not write the handoff record: {error}"),
        }
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
                    self.inner.retire(&dead);
                    // Keep what the user already saw; the provider conversation itself restarts.
                    carried = dead.transcript;
                    carried_subagents = dead.subagents;
                }
            }
        }
        if carried_subagents.is_empty() {
            if let Some(insights) = &self.inner.insights {
                carried_subagents = insights.list_subagents(session.id).unwrap_or_default();
                // A subagent cannot outlive the app, whatever it was doing when it closed.
                for record in carried_subagents.iter_mut() {
                    if record.status == SubagentStatus::Running {
                        record.status = SubagentStatus::Failed;
                    }
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
        // Investigation sessions only read; everything else may write.
        let api = self
            .inner
            .api
            .lock()
            .as_ref()
            .map(|gateway| gateway.issue(session_id, !session.kind.read_only()));
        let api_token = api.as_ref().map(|access| access.token.clone());
        let started = match backend.start(BackendContext {
            session_id,
            cwd: worktree.path,
            read_only: session.kind.read_only(),
            model: session.model.clone(),
            effort: session.effort.clone(),
            agent: session.agent.clone(),
            api,
            emit,
        }) {
            Ok(started) => started,
            Err(error) => {
                self.inner.revoke(api_token.as_deref());
                return Err(error);
            }
        };

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
                read_only: session.kind.read_only(),
                chat: session.kind == crate::domain::SessionKind::Chat,
                introduced: false,
                api_token,
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
                    "{} does not let Ataraxia change model, effort or agent",
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
        self.write_handoff(session_id, session.provider);
        self.inner
            .store
            .update_session_provider(*session_id, provider, &now_rfc3339()?)?;
        let updated = self
            .inner
            .store
            .get_session(*session_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "session not found"))?;
        // The transcript stays on screen; the new harness starts without the old context, and its
        // first prompt points it at the record written above.
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
        if let Some(child) = self.inner.linked_child(session_id, subagent_id) {
            // A BTW conversation is its own session: the message goes to it, not through the main agent.
            if let Some(session) = self.inner.store.get_session(child)? {
                self.start_session(&session)?;
            }
            self.inner
                .links
                .lock()
                .entry(child)
                .or_insert_with(|| Link {
                    parent: *session_id,
                    title: String::new(),
                });
            self.inner.handle_event(
                *session_id,
                BackendEvent::Subagent {
                    id: subagent_id.to_string(),
                    title: String::new(),
                    update: SubagentUpdate::User {
                        text: text.to_string(),
                    },
                },
            );
            self.prompt(&child, text)?;
            return Ok(());
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

    fn link_subagent(
        &self,
        child: &SessionId,
        parent: &SessionId,
        title: &str,
        question: &str,
    ) -> Result<()> {
        // The parent has to be live for its subagent list to take the new entry.
        let parent_live = self.inner.sessions.lock().contains_key(parent);
        if !parent_live {
            if let Some(session) = self.inner.store.get_session(*parent)? {
                self.start_session(&session)?;
            }
        }
        self.inner.links.lock().insert(
            *child,
            Link {
                parent: *parent,
                title: title.to_string(),
            },
        );
        let id = child.0.to_string();
        // It runs beside the chat, not inside one of its turns: it outlives the turn that is running.
        for update in [
            SubagentUpdate::Detached,
            SubagentUpdate::User {
                text: question.to_string(),
            },
            SubagentUpdate::Started,
        ] {
            self.inner.handle_event(
                *parent,
                BackendEvent::Subagent {
                    id: id.clone(),
                    title: title.to_string(),
                    update,
                },
            );
        }
        Ok(())
    }

    fn stop_session(&self, session_id: &SessionId) {
        let removed = self.inner.sessions.lock().remove(session_id);
        if let Some(live) = removed {
            self.inner.persist(*session_id, &live.transcript);
            self.inner.persist_subagents(*session_id, &live.subagents);
            self.inner.retire(&live);
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
        let guide_index = self.inner.guide.lock().clone();
        let (backend, introduce) = {
            let mut sessions = self.inner.sessions.lock();
            let live = sessions
                .get_mut(session_id)
                .ok_or_else(|| Error::new(ErrorCode::NotFound, "agent session not started"))?;
            if live.active_turn.is_some() {
                return Err(Error::new(ErrorCode::Invalid, "a turn is already running"));
            }
            // The first message of each agent process says what Ataraxia is; later ones do not.
            let introduce = live.chat && !live.introduced && guide_index.is_some();
            if introduce {
                live.introduced = true;
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
            (Arc::clone(&live.backend), introduce)
        };

        // The first message after a switch also tells the new agent where the old conversation is.
        let handoff = self.inner.handoffs.lock().remove(session_id);
        let mut sent = String::new();
        if let (true, Some(index)) = (introduce, &guide_index) {
            sent.push_str(&guide::preamble(index));
        }
        if let Some(path) = &handoff {
            sent.push_str(&handoff::preamble(path));
        }
        sent.push_str(text);
        if let Err(error) = backend.prompt(turn_id, &sent) {
            if let Some(path) = handoff {
                self.inner.handoffs.lock().insert(*session_id, path);
            }
            if introduce {
                if let Some(live) = self.inner.sessions.lock().get_mut(session_id) {
                    live.introduced = false;
                }
            }
            self.inner.handle(
                *session_id,
                BackendEvent::Error {
                    message: error.message.clone(),
                },
            );
            return Err(error);
        }
        let link = self.inner.links.lock().get(session_id).cloned();
        if let Some(link) = link {
            self.inner.handle_event(
                link.parent,
                BackendEvent::Subagent {
                    id: session_id.0.to_string(),
                    title: link.title,
                    update: SubagentUpdate::Started,
                },
            );
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
        harness_with_api(backend, None)
    }

    fn harness_with_api(
        backend: Arc<dyn AgentBackend>,
        api: Option<Arc<dyn ApiGateway>>,
    ) -> Harness {
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
            kind: crate::domain::SessionKind::Chat,
            parent_session_id: None,
            created_at: "t".into(),
            updated_at: "t".into(),
            last_opened_at: None,
        };
        store.create_session(&session).expect("session");
        let sink = Arc::new(RecordingSink::default());
        let mut host = AgentHost::new(store.clone(), sink.clone())
            .with_backend(ProviderKind::Fake, backend)
            // A second harness to switch to.
            .with_backend(
                ProviderKind::Codex,
                Arc::new(FakeBackend::new(Duration::ZERO)),
            );
        if let Some(api) = api {
            host = host.with_api(api);
        }
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

    /// Hands out numbered tokens and remembers what was issued and revoked.
    #[derive(Default)]
    struct FakeGateway {
        issued: Mutex<Vec<(SessionId, bool, String)>>,
        revoked: Mutex<Vec<String>>,
    }

    impl ApiGateway for FakeGateway {
        fn issue(&self, session_id: SessionId, write: bool) -> crate::ports::ApiAccess {
            let mut issued = self.issued.lock();
            let token = format!("token-{}", issued.len());
            issued.push((session_id, write, token.clone()));
            crate::ports::ApiAccess {
                url: "http://127.0.0.1:1".into(),
                token,
            }
        }

        fn revoke(&self, token: &str) {
            self.revoked.lock().push(token.to_string());
        }
    }

    /// A fake backend that remembers the API access each start was given.
    struct Spy {
        inner: FakeBackend,
        seen: Arc<Mutex<Vec<Option<crate::ports::ApiAccess>>>>,
    }

    impl AgentBackend for Spy {
        fn start(&self, ctx: BackendContext) -> Result<Arc<dyn BackendSession>> {
            self.seen.lock().push(ctx.api.clone());
            self.inner.start(ctx)
        }
    }

    #[test]
    fn each_agent_process_gets_its_own_token_and_loses_it_when_it_stops() {
        let gateway = Arc::new(FakeGateway::default());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let h = harness_with_api(
            Arc::new(Spy {
                inner: FakeBackend::new(Duration::ZERO),
                seen: Arc::clone(&seen),
            }),
            Some(gateway.clone()),
        );
        // A chat may write; the process was handed the token the gateway issued.
        assert_eq!(
            gateway.issued.lock().clone(),
            vec![(h.session.id, true, "token-0".to_string())]
        );
        assert_eq!(
            seen.lock()[0].as_ref().map(|a| a.token.as_str()),
            Some("token-0")
        );

        // A hidden investigation session only reads.
        let mut btw = h.session.clone();
        btw.id = SessionId::new();
        btw.kind = crate::domain::SessionKind::Btw;
        h.store.create_session(&btw).expect("btw session");
        h.host.start_session(&btw).expect("start btw");
        assert_eq!(
            gateway.issued.lock()[1],
            (btw.id, false, "token-1".to_string())
        );

        // Starting a running session again does not issue another token.
        h.host
            .start_session(&h.session)
            .expect("restart is a no-op");
        assert_eq!(gateway.issued.lock().len(), 2);
        assert!(gateway.revoked.lock().is_empty());

        // Stopping the process revokes its token, and only its own.
        h.host.stop_session(&h.session.id);
        assert_eq!(gateway.revoked.lock().clone(), vec!["token-0".to_string()]);

        // A fresh process gets a fresh token.
        h.host.start_session(&h.session).expect("start again");
        assert_eq!(gateway.issued.lock()[2].2, "token-2");

        // Shutting the app down revokes whatever is left.
        h.host.shutdown_all();
        let mut revoked = gateway.revoked.lock().clone();
        revoked.sort();
        assert_eq!(revoked, vec!["token-0", "token-1", "token-2"]);
    }

    #[test]
    fn a_backend_that_cannot_start_does_not_leave_a_live_token_behind() {
        struct Refuses;
        impl AgentBackend for Refuses {
            fn start(&self, _ctx: BackendContext) -> Result<Arc<dyn BackendSession>> {
                Err(Error::new(ErrorCode::Agent, "no"))
            }
        }
        let gateway = Arc::new(FakeGateway::default());
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
            kind: crate::domain::SessionKind::Chat,
            parent_session_id: None,
            created_at: "t".into(),
            updated_at: "t".into(),
            last_opened_at: None,
        };
        store.create_session(&session).expect("session");
        let host = AgentHost::new(store, Arc::new(RecordingSink::default()))
            .with_backend(ProviderKind::Fake, Arc::new(Refuses))
            .with_api(gateway.clone());
        assert!(host.start_session(&session).is_err());
        assert_eq!(gateway.revoked.lock().clone(), vec!["token-0".to_string()]);
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
    fn switching_harness_writes_the_conversation_and_tells_the_new_agent_once() {
        struct Recorder(Arc<Mutex<Vec<String>>>);
        impl AgentBackend for Recorder {
            fn start(&self, ctx: BackendContext) -> Result<Arc<dyn BackendSession>> {
                let prompts = Arc::clone(&self.0);
                FakeBackend::new(Duration::ZERO).start(ctx).map(|inner| {
                    struct Wrapped(Arc<dyn BackendSession>, Arc<Mutex<Vec<String>>>);
                    impl BackendSession for Wrapped {
                        fn prompt(&self, turn_id: TurnId, text: &str) -> Result<()> {
                            self.1.lock().push(text.to_string());
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
                    Arc::new(Wrapped(inner, prompts)) as Arc<dyn BackendSession>
                })
            }
        }
        let mut h = harness();
        let prompts = Arc::new(Mutex::new(Vec::new()));
        h.host.backends.insert(
            ProviderKind::Codex,
            Arc::new(Recorder(Arc::clone(&prompts))),
        );
        let dir = std::env::temp_dir().join(format!("ataraxia-handoff-{}", Uuid::new_v4()));
        *h.host.inner.handoff_dir.lock() = Some(dir.clone());

        h.host
            .prompt(&h.session.id, "first question")
            .expect("prompt");
        h.sink
            .wait_for("permission", |events| pending_request(events).is_some());
        h.host.cancel(&h.session.id, None).expect("cancel");
        h.sink
            .wait_for("turn done", |events| turn_done(events).is_some());
        h.host
            .switch_provider(&h.session.id, ProviderKind::Codex)
            .expect("switch");

        let record =
            std::fs::read_to_string(handoff::handoff_path(&dir, &h.session.id)).expect("record");
        assert!(record.contains("[user]\nfirst question"), "{record}");
        assert!(record.contains("[agent]"), "{record}");
        assert!(record.contains("[tool] read_file"), "{record}");

        h.host
            .prompt(&h.session.id, "second question")
            .expect("prompt");
        h.sink.wait_for("second turn", |events| {
            events
                .iter()
                .filter(|event| matches!(event, AgentEvent::Permission { .. }))
                .count()
                >= 1
        });
        h.host.cancel(&h.session.id, None).expect("cancel");
        h.sink.wait_for("both turns", |events| {
            events
                .iter()
                .filter(|event| matches!(event, AgentEvent::TurnDone { .. }))
                .count()
                >= 2
        });
        h.host
            .prompt(&h.session.id, "third question")
            .expect("prompt");
        let sent = prompts.lock().clone();
        assert!(sent[0].contains("continues a conversation"), "{}", sent[0]);
        assert!(
            sent[0].contains(
                &handoff::handoff_path(&dir, &h.session.id)
                    .display()
                    .to_string()
            )
        );
        assert!(sent[0].ends_with("second question"));
        assert_eq!(
            sent[1], "third question",
            "only the first message after a switch carries it"
        );
        let shown = h.host.snapshot(&h.session.id).expect("snapshot");
        assert!(shown.items.iter().all(|item| match item {
            ChatItem::Message(message) => !message.text.contains("continues a conversation"),
            _ => true,
        }));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A backend that remembers what it was asked, wrapped around the fake one.
    struct Recorder(Arc<Mutex<Vec<String>>>);
    impl AgentBackend for Recorder {
        fn start(&self, ctx: BackendContext) -> Result<Arc<dyn BackendSession>> {
            let prompts = Arc::clone(&self.0);
            FakeBackend::new(Duration::ZERO).start(ctx).map(|inner| {
                struct Wrapped(Arc<dyn BackendSession>, Arc<Mutex<Vec<String>>>);
                impl BackendSession for Wrapped {
                    fn prompt(&self, turn_id: TurnId, text: &str) -> Result<()> {
                        self.1.lock().push(text.to_string());
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
                Arc::new(Wrapped(inner, prompts)) as Arc<dyn BackendSession>
            })
        }
    }

    #[test]
    fn the_first_message_of_a_chat_says_what_ataraxia_is_and_points_at_the_guide_once() {
        let mut h = harness();
        let prompts = Arc::new(Mutex::new(Vec::new()));
        h.host
            .backends
            .insert(ProviderKind::Fake, Arc::new(Recorder(Arc::clone(&prompts))));
        let dir = std::env::temp_dir().join(format!("ataraxia-guide-{}", Uuid::new_v4()));
        let index = guide::install(&dir).expect("guide");
        *h.host.inner.guide.lock() = Some(index.clone());
        // The harness started its session before the recorder was in place; start it again.
        h.host.shutdown_all();
        h.host.start_session(&h.session).expect("restart");

        h.host
            .prompt(&h.session.id, "review my change")
            .expect("prompt");
        h.sink
            .wait_for("permission", |events| pending_request(events).is_some());
        h.host.cancel(&h.session.id, None).expect("cancel");
        h.sink
            .wait_for("turn done", |events| turn_done(events).is_some());
        h.host
            .prompt(&h.session.id, "and the tests?")
            .expect("prompt");

        let sent = prompts.lock().clone();
        assert!(sent[0].contains("Never generate"), "{}", sent[0]);
        assert!(sent[0].contains(&index.display().to_string()));
        assert!(sent[0].ends_with("review my change"));
        assert_eq!(
            sent[1], "and the tests?",
            "only the first message of an agent process says it"
        );
        // What the developer sees is what they typed.
        let shown = h.host.snapshot(&h.session.id).expect("snapshot");
        assert!(shown.items.iter().all(|item| match item {
            ChatItem::Message(message) => !message.text.contains("Never generate"),
            _ => true,
        }));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_helper_session_is_not_told_about_the_guide() {
        let mut h = harness();
        let prompts = Arc::new(Mutex::new(Vec::new()));
        h.host
            .backends
            .insert(ProviderKind::Fake, Arc::new(Recorder(Arc::clone(&prompts))));
        let dir = std::env::temp_dir().join(format!("ataraxia-guide-{}", Uuid::new_v4()));
        *h.host.inner.guide.lock() = Some(guide::install(&dir).expect("guide"));
        let mut helper = h.session.clone();
        helper.id = SessionId::new();
        helper.kind = crate::domain::SessionKind::Btw;
        h.store.create_session(&helper).expect("helper");
        h.host.start_session(&helper).expect("start");
        h.host
            .prompt(&helper.id, "what does this do")
            .expect("prompt");
        assert_eq!(
            prompts.lock().clone(),
            vec!["what does this do".to_string()]
        );
        let _ = std::fs::remove_dir_all(dir);
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

    /// A hidden session of the harness's chat, the way BTW makes one.
    fn btw_child(h: &Harness) -> ChatSession {
        let mut child = h.session.clone();
        child.id = SessionId::new();
        child.title = "BTW: why is it slow".into();
        child.kind = crate::domain::SessionKind::Btw;
        child.parent_session_id = Some(h.session.id);
        h.store.create_session(&child).expect("child");
        child
    }

    #[test]
    fn a_btw_conversation_is_listed_among_the_chats_subagents_and_follows_its_events() {
        let h = harness();
        h.host.start_session(&h.session).expect("parent");
        let child = btw_child(&h);
        h.host.start_session(&child).expect("child start");
        h.host
            .link_subagent(&child.id, &h.session.id, &child.title, "why is it slow?")
            .expect("link");

        let id = child.id.0.to_string();
        let listed = h.host.snapshot(&h.session.id).expect("snapshot");
        let record = listed
            .subagents
            .iter()
            .find(|item| item.id == id)
            .expect("listed");
        assert_eq!(record.title, "BTW: why is it slow");
        assert!(record.detached, "it outlives the chat's own turn");
        assert!(
            matches!(&record.items[0], ChatItem::Message(m) if m.role == ChatRole::User && m.text == "why is it slow?")
        );

        // The child answers; the chat's subagent conversation shows it, and ends done.
        h.host.prompt(&child.id, "why is it slow?").expect("ask");
        h.sink.wait_for("the child's answer in the chat's subagent", |events| {
            events
                .iter()
                .any(|event| matches!(event, AgentEvent::Subagent { session_id, update: SubagentUpdate::Done { ok: true }, .. } if *session_id == h.session.id))
        });
        let after = h.host.snapshot(&h.session.id).expect("snapshot");
        let record = after
            .subagents
            .iter()
            .find(|item| item.id == id)
            .expect("still listed");
        assert_eq!(record.status, SubagentStatus::Done);
        assert!(
            record.items.iter().any(|item| matches!(item, ChatItem::Message(m) if m.role == ChatRole::Assistant && !m.text.is_empty())),
            "the answer is in the subagent's conversation"
        );
    }

    #[test]
    fn a_message_to_a_btw_subagent_goes_to_its_own_conversation() {
        let h = harness();
        h.host.start_session(&h.session).expect("parent");
        let child = btw_child(&h);
        h.host.start_session(&child).expect("child start");
        h.host
            .link_subagent(&child.id, &h.session.id, &child.title, "first")
            .expect("link");
        h.host.prompt(&child.id, "first").expect("first");
        h.sink.wait_for("first answer", |events| {
            events.iter().any(|event| {
                matches!(
                    event,
                    AgentEvent::Subagent {
                        update: SubagentUpdate::Done { .. },
                        ..
                    }
                )
            })
        });

        h.host
            .message_subagent(
                &h.session.id,
                &child.id.0.to_string(),
                "and the second part?",
            )
            .expect("message");

        // The chat's own agent was not asked to relay anything: its status is untouched.
        assert_eq!(
            h.host.snapshot(&h.session.id).expect("snapshot").status,
            SessionStatus::Ready
        );
        let child_items = h.host.snapshot(&child.id).expect("child snapshot").items;
        assert!(child_items
            .iter()
            .any(|item| matches!(item, ChatItem::Message(m) if m.role == ChatRole::User && m.text == "and the second part?")));
        let listed = h.host.snapshot(&h.session.id).expect("snapshot");
        let record = listed
            .subagents
            .iter()
            .find(|item| item.id == child.id.0.to_string())
            .expect("listed");
        assert!(record
            .items
            .iter()
            .any(|item| matches!(item, ChatItem::Message(m) if m.role == ChatRole::User && m.text == "and the second part?")));
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
