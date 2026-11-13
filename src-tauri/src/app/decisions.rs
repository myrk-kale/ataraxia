//! Decisions: judging them, discussing them, and asking for changes.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::engine::Engine;
use crate::domain::ids::{SessionId, TurnId};
use crate::domain::{
    CodeRef, CommitInfo, Decision, DecisionCommit, DecisionId, DecisionKind, DecisionMessage,
    DecisionRevision, DecisionState, Error, ErrorCode, InsightEvent, Result, SessionKind,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaterChange {
    pub checkpoint_id: crate::domain::ids::CheckpointId,
    pub seq: u32,
    pub paths: Vec<String>,
}

/// A commit offered for linking, with why it was suggested.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitCandidate {
    pub commit: CommitInfo,
    /// It touched files this decision points at.
    pub touches_decision_files: bool,
    pub linked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionDetail {
    pub decision: Decision,
    pub messages: Vec<DecisionMessage>,
    pub revisions: Vec<DecisionRevision>,
    /// Commits someone said influence this decision.
    pub commits: Vec<DecisionCommit>,
    /// Checkpoints after this one that touched the files the decision points at.
    pub later_changes: Vec<LaterChange>,
    /// Sequence number of the checkpoint the decision came from.
    pub checkpoint_seq: u32,
}

fn session_pref(id: DecisionId) -> String {
    format!("decision_session:{}", id.0)
}

fn describe(decision: &Decision) -> String {
    let mut out = format!(
        "Decision ({}): {}\nSummary: {}\n",
        decision.kind.as_str(),
        decision.title,
        decision.summary
    );
    if !decision.context.is_empty() {
        out.push_str(&format!("Context: {}\n", decision.context));
    }
    if !decision.rationale.is_empty() {
        out.push_str(&format!("Rationale: {}\n", decision.rationale));
    }
    for alternative in &decision.alternatives {
        out.push_str(&format!(
            "Alternative: {} {}\n",
            alternative.title, alternative.note
        ));
    }
    for reference in &decision.refs {
        match reference.start_line {
            Some(line) => out.push_str(&format!("Code: {}:{line}\n", reference.path)),
            None => out.push_str(&format!("Code: {}\n", reference.path)),
        }
    }
    out
}

impl Engine {
    /// The number the next decision of a chat gets, read when it is about to be saved.
    pub(crate) fn next_decision_seq(&self, session_id: SessionId) -> Result<u32> {
        Ok(self
            .db
            .list_decisions(session_id)?
            .iter()
            .map(|decision| decision.seq)
            .max()
            .unwrap_or(0)
            + 1)
    }

    pub fn decisions(&self, session_id: SessionId) -> Result<Vec<Decision>> {
        self.db.list_decisions(session_id)
    }

    /// The folder of the repository a decision's checkpoint belongs to.
    fn decision_root(&self, decision: &Decision) -> Result<std::path::PathBuf> {
        let checkpoint = self
            .db
            .get_checkpoint(decision.checkpoint_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "checkpoint not found"))?;
        Ok(self
            .db
            .get_worktree(checkpoint.worktree_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "worktree not found"))?
            .path)
    }

    fn decision(&self, id: DecisionId) -> Result<Decision> {
        self.db
            .get_decision(id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "decision not found"))
    }

    pub fn decision_detail(&self, id: DecisionId) -> Result<DecisionDetail> {
        let decision = self.decision(id)?;
        let checkpoints = self.db.list_checkpoints(decision.session_id)?;
        let origin = checkpoints
            .iter()
            .find(|checkpoint| checkpoint.id == decision.checkpoint_id)
            .map_or(0, |checkpoint| checkpoint.seq);
        let later_changes = checkpoints
            .iter()
            .filter(|checkpoint| checkpoint.seq > origin)
            .filter_map(|checkpoint| {
                let paths: Vec<String> = checkpoint
                    .files
                    .iter()
                    .filter(|file| {
                        decision
                            .refs
                            .iter()
                            .any(|reference| reference.path == file.path)
                    })
                    .map(|file| file.path.clone())
                    .collect();
                (!paths.is_empty()).then_some(LaterChange {
                    checkpoint_id: checkpoint.id,
                    seq: checkpoint.seq,
                    paths,
                })
            })
            .collect();
        Ok(DecisionDetail {
            messages: self.db.list_decision_messages(id)?,
            revisions: self.db.decision_revisions(id)?,
            commits: self.db.list_decision_commits(id)?,
            later_changes,
            checkpoint_seq: origin,
            decision,
        })
    }

    /// Opens a decision by hand, the way one opens an issue. It belongs to the chat, and is
    /// anchored to the newest checkpoint (or an empty one when nothing has changed yet).
    pub fn create_decision(
        self: &Arc<Self>,
        session_id: SessionId,
        title: &str,
        summary: &str,
        kind: DecisionKind,
        refs: Vec<CodeRef>,
        opened_by: &str,
    ) -> Result<Decision> {
        let (title, summary) = (title.trim(), summary.trim());
        if title.is_empty() {
            return Err(Error::new(ErrorCode::Invalid, "a decision needs a title"));
        }
        let session = self.session(session_id)?;
        let checkpoint = match self.db.latest_checkpoint(session_id)? {
            Some(checkpoint) => checkpoint,
            None => self.baseline_checkpoint(&session)?,
        };
        let seq = self.next_decision_seq(session_id)?;
        let now = self.now();
        let decision = Decision {
            id: DecisionId::new(),
            session_id,
            checkpoint_id: checkpoint.id,
            artifact_id: None,
            seq,
            kind,
            title: title.to_string(),
            summary: if summary.is_empty() {
                title.to_string()
            } else {
                summary.to_string()
            },
            context: String::new(),
            rationale: String::new(),
            alternatives: Vec::new(),
            refs,
            state: DecisionState::Pending,
            version: 1,
            superseded_by: None,
            opened_by: opened_by.to_string(),
            created_at: now.clone(),
            updated_at: now,
        };
        self.db.insert_decision(&decision)?;
        self.sink
            .emit_insight(InsightEvent::Decisions { session_id });
        Ok(decision)
    }

    /// Says that a commit influences a decision. A branch, tag or short id is resolved to the
    /// commit. Linking the same commit again only updates its note.
    pub fn link_decision_commit(
        &self,
        id: DecisionId,
        rev: &str,
        note: &str,
        linked_by: &str,
    ) -> Result<DecisionCommit> {
        let decision = self.decision(id)?;
        let session = self.session(decision.session_id)?;
        // The commit may be in any repository of the workspace; the decision's own is tried first.
        let own = self.decision_root(&decision)?;
        let mut roots = vec![own.clone()];
        roots.extend(
            super::workspace::session_roots(self.db.as_ref(), &session)?
                .into_iter()
                .map(|(_, path)| path)
                .filter(|path| *path != own),
        );
        let mut found = None;
        let mut failure = None;
        for root in &roots {
            match self.git.commit_info(root, rev.trim()) {
                Ok(info) => {
                    found = Some(info);
                    break;
                }
                Err(error) => failure = failure.or(Some(error)),
            }
        }
        let info = match (found, failure) {
            (Some(info), _) => info,
            (None, Some(error)) => return Err(error),
            (None, None) => return Err(Error::new(ErrorCode::NotFound, "worktree not found")),
        };
        let created_at = self
            .db
            .list_decision_commits(id)?
            .into_iter()
            .find(|commit| commit.rev == info.rev)
            .map_or_else(|| self.now(), |commit| commit.created_at);
        let linked = DecisionCommit {
            decision_id: id,
            rev: info.rev,
            short: info.short,
            subject: info.subject,
            author: info.author,
            committed_at: info.date,
            note: note.trim().to_string(),
            linked_by: linked_by.to_string(),
            created_at,
        };
        self.db.add_decision_commit(&linked)?;
        self.sink
            .emit_insight(InsightEvent::DecisionThread { decision_id: id });
        Ok(linked)
    }

    pub fn unlink_decision_commit(&self, id: DecisionId, rev: &str) -> Result<()> {
        self.decision(id)?;
        self.db.remove_decision_commit(id, rev)?;
        self.sink
            .emit_insight(InsightEvent::DecisionThread { decision_id: id });
        Ok(())
    }

    /// Recent commits, those that touched files the decision points at first.
    pub fn decision_commit_candidates(&self, id: DecisionId) -> Result<Vec<CommitCandidate>> {
        let decision = self.decision(id)?;
        let root = self.decision_root(&decision)?;
        let linked: Vec<String> = self
            .db
            .list_decision_commits(id)?
            .into_iter()
            .map(|commit| commit.rev)
            .collect();
        let paths: Vec<String> = decision
            .refs
            .iter()
            .map(|reference| reference.path.clone())
            .collect();
        let mut out: Vec<CommitCandidate> = Vec::new();
        for commit in self
            .git
            .commits_touching(&root, &paths, 20)
            .unwrap_or_default()
        {
            out.push(CommitCandidate {
                linked: linked.contains(&commit.rev),
                touches_decision_files: true,
                commit,
            });
        }
        let recent = self
            .git
            .list_refs(&root)
            .map(|refs| refs.commits)
            .unwrap_or_default();
        for commit in recent {
            if out.len() >= 40 || out.iter().any(|known| known.commit.rev == commit.rev) {
                continue;
            }
            out.push(CommitCandidate {
                linked: linked.contains(&commit.rev),
                touches_decision_files: false,
                commit,
            });
        }
        Ok(out)
    }

    /// Approving or rejecting a decision says nothing about the implementation: review marks
    /// are separate, and the discussion stays open either way.
    pub fn set_decision_state(&self, id: DecisionId, state: DecisionState) -> Result<Decision> {
        self.set_decision_state_with_comment(id, state, None)
    }

    /// A verdict, with the comment the reviewer wrote beside it, if any. The comment is kept in
    /// the thread ahead of the verdict, and it is a note: nothing answers it.
    pub fn set_decision_state_with_comment(
        &self,
        id: DecisionId,
        state: DecisionState,
        comment: Option<&str>,
    ) -> Result<Decision> {
        if state == DecisionState::Superseded {
            return Err(Error::new(
                ErrorCode::Invalid,
                "a decision is superseded by a newer one, not by hand",
            ));
        }
        let mut decision = self.decision(id)?;
        if let Some(text) = comment.map(str::trim).filter(|text| !text.is_empty()) {
            self.comment_decision(id, text)?;
        }
        if decision.state == state {
            return Ok(decision);
        }
        decision.state = state;
        decision.version += 1;
        decision.updated_at = self.now();
        self.db
            .update_decision(&decision, &format!("state:{}", state.as_str()))?;
        self.sink.emit_insight(InsightEvent::Decisions {
            session_id: decision.session_id,
        });
        Ok(decision)
    }

    /// A comment in the thread, from the reviewer. Unlike a question it is not answered by an
    /// agent: it is a note for whoever reads the thread next.
    pub fn comment_decision(&self, id: DecisionId, text: &str) -> Result<DecisionMessage> {
        let text = text.trim();
        if text.is_empty() {
            return Err(Error::new(ErrorCode::Invalid, "the comment is empty"));
        }
        self.decision(id)?;
        let message = DecisionMessage {
            id: Uuid::new_v4().to_string(),
            decision_id: id,
            author: "user".into(),
            text: text.to_string(),
            code_ref: None,
            created_at: self.now(),
        };
        self.db.add_decision_message(&message)?;
        self.sink
            .emit_insight(InsightEvent::DecisionThread { decision_id: id });
        Ok(message)
    }

    /// Adds the user's question to the thread and lets a read-only agent answer. Asking is
    /// never an instruction to change files.
    pub fn post_decision_message(
        self: &Arc<Self>,
        id: DecisionId,
        text: &str,
        code_ref: Option<CodeRef>,
    ) -> Result<DecisionMessage> {
        let text = text.trim();
        if text.is_empty() {
            return Err(Error::new(ErrorCode::Invalid, "the message is empty"));
        }
        let decision = self.decision(id)?;
        let key = id.0.to_string();
        if !self.busy.lock().insert(key.clone()) {
            return Err(Error::new(
                ErrorCode::Invalid,
                "the agent is still answering the previous message",
            ));
        }
        let message = DecisionMessage {
            id: Uuid::new_v4().to_string(),
            decision_id: id,
            author: "user".into(),
            text: text.to_string(),
            code_ref,
            created_at: self.now(),
        };
        if let Err(error) = self.db.add_decision_message(&message) {
            self.busy.lock().remove(&key);
            return Err(error);
        }
        self.sink
            .emit_insight(InsightEvent::DecisionThread { decision_id: id });

        let engine = Arc::clone(self);
        std::thread::spawn(move || {
            let reply = engine.answer_decision(&decision, id);
            let (author, text) = match reply {
                Ok(text) => ("agent", text),
                Err(error) => ("system", format!("Could not answer: {}", error.message)),
            };
            let _ = engine.db.add_decision_message(&DecisionMessage {
                id: Uuid::new_v4().to_string(),
                decision_id: id,
                author: author.into(),
                text,
                code_ref: None,
                created_at: engine.now(),
            });
            engine.busy.lock().remove(&id.0.to_string());
            engine
                .sink
                .emit_insight(InsightEvent::DecisionThread { decision_id: id });
        });
        Ok(message)
    }

    fn answer_decision(&self, decision: &Decision, id: DecisionId) -> Result<String> {
        let parent = self.session(decision.session_id)?;
        let hidden = match self
            .db
            .get_preference(&session_pref(id))?
            .and_then(|value| Uuid::parse_str(&value).ok())
            .map(SessionId)
        {
            Some(existing) => self.session(existing)?,
            None => {
                let created = self.hidden_session(
                    &parent,
                    SessionKind::Decision,
                    &format!("Decision: {}", decision.title),
                )?;
                self.db
                    .set_preference(&session_pref(id), &created.id.0.to_string())?;
                created
            }
        };
        let thread = self.db.list_decision_messages(id)?;
        let mut history = String::new();
        for message in thread.iter().rev().take(12).rev() {
            let who = match message.author.as_str() {
                "user" => "Reviewer",
                "agent" => "You",
                _ => "System",
            };
            history.push_str(&format!("{who}: {}\n", message.text));
            if let Some(reference) = &message.code_ref {
                history.push_str(&format!("(about {})\n", reference.path));
            }
        }
        let prompt = format!(
            "You are discussing an engineering decision with the reviewer. Answer the last \
             message. This is read-only: explain and look at the code if you need to, but never \
             modify files, and do not take the question as a request for changes.\n\n{}\n\
             Conversation so far:\n{history}",
            describe(decision)
        );
        self.ask_and_wait(&hidden, &prompt)
    }

    /// The only way a decision leads to edits: an explicit request, sent to the main agent.
    pub fn request_decision_change(&self, id: DecisionId, text: &str) -> Result<TurnId> {
        let text = text.trim();
        if text.is_empty() {
            return Err(Error::new(
                ErrorCode::Invalid,
                "describe the change you want",
            ));
        }
        let decision = self.decision(id)?;
        let parent = self.session(decision.session_id)?;
        let prompt = format!(
            "Change requested by the reviewer on this decision.\n\n{}\nRequested change: {text}",
            describe(&decision)
        );
        self.runtime.start_session(&parent)?;
        self.turn_started(parent.id);
        let turn = self.runtime.prompt(&parent.id, &prompt)?;
        self.db.add_decision_message(&DecisionMessage {
            id: Uuid::new_v4().to_string(),
            decision_id: id,
            author: "user".into(),
            text: format!("Requested a change from the main agent: {text}"),
            code_ref: None,
            created_at: self.now(),
        })?;
        self.sink
            .emit_insight(InsightEvent::DecisionThread { decision_id: id });
        Ok(turn)
    }
}
