//! The engine: turns what agents do into checkpoints and artifacts, and runs the hidden
//! sessions (analysis, decision discussions, BTW) that produce them.
//!
//! Work is driven by runtime events, never by prompts: when a chat turn finishes, a checkpoint
//! is recorded and the specialised tasks are scheduled on their own threads, so the chat is
//! never blocked and a retry never duplicates an artifact.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::mpsc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Value, json};

use crate::domain::ids::{CheckpointId, SessionId};
use crate::domain::time::now_rfc3339;
use crate::domain::{
    AgentEvent, Artifact, ArtifactId, ArtifactKind, ArtifactStatus, ChatItem, ChatRole,
    ChatSession, Checkpoint, CheckpointSource, Error, ErrorCode, InsightEvent, Result, SessionKind,
    SessionStatus,
};
use crate::ports::{AgentRuntime, Database, Fs, Git, InsightSink, Syntax};

use super::review::prioritize;

/// How long a hidden session may take to answer before the task is declared failed.
pub const TASK_TIMEOUT: Duration = Duration::from_secs(15 * 60);

pub struct Engine {
    pub(crate) git: Arc<dyn Git>,
    pub(crate) fs: Arc<dyn Fs>,
    pub(crate) syntax: Arc<dyn Syntax>,
    pub(crate) db: Arc<dyn Database>,
    pub(crate) runtime: Arc<dyn AgentRuntime>,
    pub(crate) sink: Arc<dyn InsightSink>,
    /// Hidden sessions somebody is waiting on, woken when their turn ends.
    waiters: Mutex<HashMap<SessionId, mpsc::Sender<bool>>>,
    /// Discussions currently waiting for the agent, so a second question cannot overlap.
    pub(crate) busy: Mutex<std::collections::HashSet<String>>,
    task_timeout: Duration,
}

/// Version of the scoring model that wrote a stored review queue; an older one is recomputed.
pub(crate) const PRIORITY_VERSION: u32 = 4;

fn turn_base_key(session_id: SessionId) -> String {
    format!("turn_base:{}", session_id.0)
}

impl Engine {
    pub fn new(
        git: Arc<dyn Git>,
        fs: Arc<dyn Fs>,
        syntax: Arc<dyn Syntax>,
        db: Arc<dyn Database>,
        runtime: Arc<dyn AgentRuntime>,
        sink: Arc<dyn InsightSink>,
    ) -> Arc<Self> {
        Arc::new(Self {
            git,
            fs,
            syntax,
            db,
            runtime,
            sink,
            waiters: Mutex::new(HashMap::new()),
            busy: Mutex::new(std::collections::HashSet::new()),
            task_timeout: TASK_TIMEOUT,
        })
    }

    #[cfg(test)]
    pub fn with_timeout(self: Arc<Self>, timeout: Duration) -> Arc<Self> {
        let mut engine = Arc::try_unwrap(self).unwrap_or_else(|_| panic!("engine is shared"));
        engine.task_timeout = timeout;
        Arc::new(engine)
    }

    pub(crate) fn now(&self) -> String {
        now_rfc3339().unwrap_or_default()
    }

    pub(crate) fn session(&self, id: SessionId) -> Result<ChatSession> {
        self.db
            .get_session(id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "session not found"))
    }

    pub(crate) fn worktree_path(&self, session: &ChatSession) -> Result<std::path::PathBuf> {
        Ok(self
            .db
            .get_worktree(session.worktree_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "worktree not found"))?
            .path)
    }

    /// Called on startup: work a previous run left half done cannot continue.
    pub fn recover(&self) {
        let now = self.now();
        match self.db.interrupted_artifacts() {
            Ok(artifacts) => {
                for artifact in artifacts {
                    let _ = self.db.update_artifact(
                        artifact.id,
                        ArtifactStatus::Failed,
                        None,
                        None,
                        Some("Interrupted: the app closed while this was running. Retry it."),
                        &now,
                    );
                }
            }
            Err(error) => eprintln!("ataraxia: could not recover artifacts: {error}"),
        }
    }

    // ---------------------------------------------------------------- runtime events

    /// Feed with every agent event. Cheap and non-blocking: heavy work moves to a thread.
    pub fn on_agent_event(self: &Arc<Self>, event: &AgentEvent) {
        match event {
            AgentEvent::TurnDone {
                session_id,
                turn_id,
                ok,
            } => {
                if let Some(waiter) = self.waiters.lock().remove(session_id) {
                    let _ = waiter.send(*ok);
                    return;
                }
                let engine = Arc::clone(self);
                let (session_id, turn_id, ok) = (*session_id, turn_id.0.to_string(), *ok);
                std::thread::spawn(move || engine.turn_finished(session_id, &turn_id, ok));
            }
            AgentEvent::Error { session_id, .. } => {
                if let Some(waiter) = self.waiters.lock().remove(session_id) {
                    let _ = waiter.send(false);
                }
            }
            _ => {}
        }
    }

    /// Records where the working tree stands when a turn begins, so its changes can be told
    /// apart from whatever the user did between turns.
    pub fn turn_started(&self, session_id: SessionId) {
        let result = (|| -> Result<()> {
            let session = self.session(session_id)?;
            if session.kind != SessionKind::Chat {
                return Ok(());
            }
            let path = self.worktree_path(&session)?;
            let rev = self
                .git
                .snapshot(&path, &format!("turn-base/{}", session_id.0))?;
            self.db.set_preference(&turn_base_key(session_id), &rev)
        })();
        if let Err(error) = result {
            eprintln!("ataraxia: could not mark the turn start: {error}");
        }
    }

    fn turn_finished(self: &Arc<Self>, session_id: SessionId, turn_id: &str, ok: bool) {
        let Ok(session) = self.session(session_id) else {
            return;
        };
        match session.kind {
            SessionKind::Chat => {
                if let Err(error) = self.record_turn_checkpoint(&session, turn_id) {
                    eprintln!("ataraxia: checkpoint failed: {error}");
                }
                // A BTW that finished while this turn ran could not tell the agent then.
                self.btw_deliver(session_id);
            }
            SessionKind::Btw | SessionKind::Delegate => self.btw_turn_finished(session_id, ok),
            _ => {}
        }
    }

    // ---------------------------------------------------------------- checkpoints

    fn record_turn_checkpoint(
        self: &Arc<Self>,
        session: &ChatSession,
        turn_id: &str,
    ) -> Result<()> {
        let Some(base) = self
            .db
            .get_preference(&turn_base_key(session.id))?
            .filter(|value| !value.is_empty())
        else {
            return Ok(());
        };
        // A turn ends once: forget the base so a stray event cannot record it twice.
        self.db.set_preference(&turn_base_key(session.id), "")?;
        let path = self.worktree_path(session)?;
        let head = self
            .git
            .snapshot(&path, &format!("turn-head/{}/{turn_id}", session.id.0))?;
        if self.git.tree_id(&path, &base)? == self.git.tree_id(&path, &head)? {
            return Ok(());
        }
        let checkpoint = self.create_checkpoint(
            session,
            &path,
            base,
            head,
            CheckpointSource::Turn,
            Some(turn_id),
        )?;
        self.process_checkpoint(&checkpoint);
        Ok(())
    }

    pub(crate) fn create_checkpoint(
        &self,
        session: &ChatSession,
        path: &std::path::Path,
        base: String,
        head: String,
        source: CheckpointSource,
        turn_id: Option<&str>,
    ) -> Result<Checkpoint> {
        self.create_checkpoint_labeled(session, path, base, head, source, turn_id, None, None, true)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn create_checkpoint_labeled(
        &self,
        session: &ChatSession,
        path: &std::path::Path,
        base: String,
        head: String,
        source: CheckpointSource,
        turn_id: Option<&str>,
        base_label: Option<String>,
        head_label: Option<String>,
        head_live: bool,
    ) -> Result<Checkpoint> {
        let files = self.git.changed_files(path, &base, &head)?;
        let seq = self
            .db
            .latest_checkpoint(session.id)?
            .map_or(1, |latest| latest.seq + 1);
        let checkpoint = Checkpoint {
            id: CheckpointId::new(),
            session_id: session.id,
            repository_id: session.repository_id,
            worktree_id: session.worktree_id,
            seq,
            base_rev: base,
            head_rev: head,
            source,
            turn_id: turn_id.map(str::to_string),
            files,
            status: ArtifactStatus::Running,
            created_at: self.now(),
            base_label,
            head_label,
            head_live,
        };
        self.db.create_checkpoint(&checkpoint)?;
        self.sink.emit_insight(InsightEvent::Checkpoint {
            session_id: session.id,
            checkpoint_id: checkpoint.id,
        });
        Ok(checkpoint)
    }

    /// The syntax-aware, fact-based review priority of a checkpoint.
    pub(crate) fn static_priority(&self, checkpoint: &Checkpoint) -> super::review::ReviewPriority {
        let root = self
            .db
            .get_worktree(checkpoint.worktree_id)
            .ok()
            .flatten()
            .map(|worktree| worktree.path);
        match root {
            Some(root) => {
                super::units::compute(self.git.as_ref(), self.syntax.as_ref(), &root, checkpoint)
            }
            None => prioritize(&checkpoint.files),
        }
    }

    /// What a new checkpoint gets without anyone asking: the review queue, which is computed from
    /// the code in an instant, and staleness of older diagrams. Decisions are never generated
    /// here: the reviewer asks for them (or the agent records them in the chat).
    pub(crate) fn process_checkpoint(self: &Arc<Self>, checkpoint: &Checkpoint) {
        let now = self.now();
        let priority = self.static_priority(checkpoint);
        let review = Artifact {
            id: ArtifactId::new(),
            session_id: checkpoint.session_id,
            checkpoint_id: checkpoint.id,
            kind: ArtifactKind::ReviewPriority,
            dedupe_key: String::new(),
            version: 1,
            status: ArtifactStatus::Ready,
            content: serde_json::to_value(&priority).unwrap_or(Value::Null),
            provenance: json!({ "generator": "tree-sitter+heuristics", "version": PRIORITY_VERSION }),
            error: None,
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        if let Ok((stored, _)) = self.db.ensure_artifact(&review) {
            self.emit_artifact(&stored);
        }
        // Diagrams drawn for an older checkpoint no longer describe the code.
        if let Ok(count) = self.db.mark_artifacts_stale(
            checkpoint.session_id,
            ArtifactKind::Flow,
            checkpoint.id,
            &now,
        ) {
            if count > 0 {
                self.sink.emit_insight(InsightEvent::Checkpoint {
                    session_id: checkpoint.session_id,
                    checkpoint_id: checkpoint.id,
                });
            }
        }
        let _ = self
            .db
            .update_checkpoint_status(checkpoint.id, ArtifactStatus::Ready);
    }

    pub(crate) fn emit_artifact(&self, artifact: &Artifact) {
        self.sink.emit_insight(InsightEvent::Artifact {
            session_id: artifact.session_id,
            artifact_id: artifact.id,
            kind: artifact.kind,
            status: artifact.status,
        });
    }

    pub(crate) fn set_artifact(
        &self,
        id: ArtifactId,
        status: ArtifactStatus,
        content: Option<&Value>,
        provenance: Option<&Value>,
        error: Option<&str>,
    ) -> Result<Artifact> {
        self.db
            .update_artifact(id, status, content, provenance, error, &self.now())?;
        let artifact = self
            .db
            .get_artifact(id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "artifact not found"))?;
        self.emit_artifact(&artifact);
        Ok(artifact)
    }

    // ---------------------------------------------------------------- hidden sessions

    /// Creates the hidden child of `parent` that runs a task.
    pub(crate) fn hidden_session(
        &self,
        parent: &ChatSession,
        kind: SessionKind,
        title: &str,
    ) -> Result<ChatSession> {
        self.hidden_session_with(parent, kind, title, None, None)
    }

    /// Like [`Self::hidden_session`], on another provider and model than the parent's.
    pub(crate) fn hidden_session_with(
        &self,
        parent: &ChatSession,
        kind: SessionKind,
        title: &str,
        provider: Option<crate::domain::agent::ProviderKind>,
        model: Option<String>,
    ) -> Result<ChatSession> {
        let now = self.now();
        let session = ChatSession {
            id: SessionId::new(),
            repository_id: parent.repository_id,
            worktree_id: parent.worktree_id,
            provider: provider.unwrap_or(parent.provider),
            title: title.to_string(),
            status: SessionStatus::Idle,
            model,
            effort: None,
            agent: None,
            kind,
            parent_session_id: Some(parent.id),
            created_at: now.clone(),
            updated_at: now,
            last_opened_at: None,
        };
        self.db.create_session(&session)?;
        Ok(session)
    }

    /// Sends one prompt to a hidden session and waits for its answer text.
    pub(crate) fn ask_and_wait(&self, session: &ChatSession, prompt: &str) -> Result<String> {
        let (sender, receiver) = mpsc::channel();
        self.waiters.lock().insert(session.id, sender);
        let outcome = (|| -> Result<bool> {
            self.runtime.start_session(session)?;
            self.runtime.prompt(&session.id, prompt)?;
            receiver
                .recv_timeout(self.task_timeout)
                .map_err(|_| Error::new(ErrorCode::Agent, "the agent took too long to answer"))
        })();
        self.waiters.lock().remove(&session.id);
        let answer = self.last_answer(&session.id);
        self.runtime.stop_session(&session.id);
        match outcome? {
            true => answer
                .filter(|text| !text.trim().is_empty())
                .ok_or_else(|| Error::new(ErrorCode::Agent, "the agent returned no answer")),
            false => Err(Error::new(
                ErrorCode::Agent,
                "the agent could not finish the task",
            )),
        }
    }

    /// The assistant text of the last turn of a session.
    pub(crate) fn last_answer(&self, session_id: &SessionId) -> Option<String> {
        let items = self
            .runtime
            .snapshot(session_id)
            .map(|snapshot| snapshot.items)
            .ok()
            .filter(|items| !items.is_empty())
            .or_else(|| self.db.list_chat_items(*session_id).ok())?;
        let last_user = items.iter().rposition(
            |item| matches!(item, ChatItem::Message(message) if message.role == ChatRole::User),
        );
        let start = last_user.map_or(0, |index| index + 1);
        let text: Vec<String> = items[start..]
            .iter()
            .filter_map(|item| match item {
                ChatItem::Message(message) if message.role == ChatRole::Assistant => {
                    Some(message.text.clone())
                }
                _ => None,
            })
            .collect();
        Some(text.join("\n\n"))
    }
}

/// Forwards agent events to the UI and lets the engine react to them. The engine is attached
/// afterwards because it needs the agent host, which needs this sink.
pub struct TeeEventSink {
    inner: Arc<dyn crate::ports::EventSink>,
    engine: std::sync::OnceLock<std::sync::Weak<Engine>>,
}

impl TeeEventSink {
    pub fn new(inner: Arc<dyn crate::ports::EventSink>) -> Self {
        Self {
            inner,
            engine: std::sync::OnceLock::new(),
        }
    }

    pub fn attach(&self, engine: &Arc<Engine>) {
        let _ = self.engine.set(Arc::downgrade(engine));
    }
}

impl crate::ports::EventSink for TeeEventSink {
    fn emit_agent(&self, event: AgentEvent) {
        if let Some(engine) = self.engine.get().and_then(std::sync::Weak::upgrade) {
            engine.on_agent_event(&event);
        }
        self.inner.emit_agent(event);
    }
}
