//! Artifact generation (decisions) and the Code space: files, checkpoints, review.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use super::analysis::{decisions_prompt, parse_decisions};
use super::engine::Engine;
use super::review::{ReviewPriority, prioritize};
use crate::domain::agent::ProviderKind;
use crate::domain::ids::{CheckpointId, SessionId, WorktreeId};
use crate::domain::{
    Artifact, ArtifactId, ArtifactKind, ArtifactStatus, Checkpoint, CheckpointSource, Decision,
    DecisionId, DecisionMessage, DecisionState, Error, ErrorCode, InsightEvent, Result,
    ReviewComment, ReviewMark, ReviewState, SessionKind,
};
use crate::ports::FileContent;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewView {
    pub checkpoints: Vec<Checkpoint>,
    pub checkpoint: Option<Checkpoint>,
    pub priority: Option<ReviewPriority>,
    pub marks: Vec<ReviewMark>,
    pub comments: Vec<ReviewComment>,
    pub artifacts: Vec<Artifact>,
}

/// What a deletion of a chat's artifacts removed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClearedArtifacts {
    pub checkpoints: usize,
    pub decisions: usize,
    pub diagrams: usize,
}

/// Which side of a checkpoint to read a file from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Side {
    Base,
    Head,
}

const MAX_DIFF_FILES: usize = 14;

impl Engine {
    // ---------------------------------------------------------------- decisions

    /// Generates decisions for a checkpoint (the latest by default), on the provider and model the
    /// reviewer picked, or on the chat's own. Nothing calls this by itself.
    pub fn generate_decisions(
        self: &Arc<Self>,
        session_id: SessionId,
        checkpoint_id: Option<CheckpointId>,
        provider: Option<ProviderKind>,
        model: Option<String>,
    ) -> Result<Artifact> {
        self.generate_decisions_focused(session_id, checkpoint_id, provider, model, None)
    }

    /// Like [`Self::generate_decisions`], with a note on what the developer wants it to look at.
    pub fn generate_decisions_focused(
        self: &Arc<Self>,
        session_id: SessionId,
        checkpoint_id: Option<CheckpointId>,
        provider: Option<ProviderKind>,
        model: Option<String>,
        focus: Option<String>,
    ) -> Result<Artifact> {
        let focus = focus
            .map(|text| text.trim().chars().take(500).collect::<String>())
            .filter(|text| !text.is_empty());
        let session = self.session(session_id)?;
        let checkpoint = match checkpoint_id {
            Some(id) => self.db.get_checkpoint(id)?,
            None => self.db.latest_checkpoint(session_id)?,
        }
        .ok_or_else(|| {
            Error::new(
                ErrorCode::Invalid,
                "nothing has changed in this chat yet, so there is nothing to decide about",
            )
        })?;
        if checkpoint.files.is_empty() {
            return Err(Error::new(
                ErrorCode::Invalid,
                "this checkpoint changed no files",
            ));
        }
        let running = self
            .db
            .list_artifacts(session_id, Some(ArtifactKind::Decision))?
            .into_iter()
            .any(|artifact| {
                matches!(
                    artifact.status,
                    ArtifactStatus::Queued | ArtifactStatus::Running
                )
            });
        if running {
            return Err(Error::new(
                ErrorCode::Invalid,
                "decisions are already being generated for this chat",
            ));
        }
        let provider = provider.unwrap_or(session.provider);
        let model = model.filter(|model| !model.trim().is_empty());
        let now = self.now();
        let draft = Artifact {
            id: ArtifactId::new(),
            session_id,
            checkpoint_id: checkpoint.id,
            kind: ArtifactKind::Decision,
            // Each request is its own run, so asking again with another model keeps both.
            dedupe_key: Uuid::new_v4().simple().to_string(),
            version: 1,
            status: ArtifactStatus::Queued,
            content: json!({}),
            provenance: json!({
                "generator": "agent-analysis",
                "promptVersion": 2,
                "provider": provider.as_str(),
                "model": model,
                "focus": focus,
            }),
            error: None,
            created_at: now.clone(),
            updated_at: now,
        };
        let (stored, _) = self.db.ensure_artifact(&draft)?;
        self.emit_artifact(&stored);
        let engine = Arc::clone(self);
        let artifact_id = stored.id;
        std::thread::spawn(move || engine.run_decisions(artifact_id));
        Ok(stored)
    }

    pub(crate) fn rerun_decisions(self: &Arc<Self>, artifact: Artifact) -> Result<Artifact> {
        let queued = self.set_artifact(artifact.id, ArtifactStatus::Queued, None, None, None)?;
        self.emit_artifact(&queued);
        let engine = Arc::clone(self);
        let id = queued.id;
        std::thread::spawn(move || engine.run_decisions(id));
        Ok(queued)
    }

    fn run_decisions(self: &Arc<Self>, id: ArtifactId) {
        let outcome = self.decisions_task(id);
        let Ok(Some(artifact)) = self.db.get_artifact(id) else {
            return;
        };
        let (status, error) = match &outcome {
            Ok(_) => (ArtifactStatus::Ready, None),
            Err(error) => (ArtifactStatus::Failed, Some(error.message.clone())),
        };
        let content = outcome
            .as_ref()
            .ok()
            .map(|(opened, extended)| json!({ "count": opened, "extended": extended }));
        let _ = self.set_artifact(id, status, content.as_ref(), None, error.as_deref());
        self.sink.emit_insight(InsightEvent::Decisions {
            session_id: artifact.session_id,
        });
    }

    /// Returns how many threads were opened and how many existing ones were extended.
    fn decisions_task(self: &Arc<Self>, id: ArtifactId) -> Result<(usize, usize)> {
        let artifact = self.set_artifact(id, ArtifactStatus::Running, None, None, None)?;
        self.emit_artifact(&artifact);
        let checkpoint = self
            .db
            .get_checkpoint(artifact.checkpoint_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "checkpoint not found"))?;
        let session = self.session(artifact.session_id)?;
        let root = self.worktree_path(&session)?;
        let provider = artifact.provenance["provider"]
            .as_str()
            .and_then(ProviderKind::parse)
            .unwrap_or(session.provider);
        let model = artifact.provenance["model"].as_str().map(str::to_string);

        let ranked = prioritize(&checkpoint.files);
        let mut diffs = Vec::new();
        for score in ranked.files.iter().take(MAX_DIFF_FILES) {
            let binary = checkpoint
                .files
                .iter()
                .any(|file| file.path == score.path && file.binary);
            if binary {
                continue;
            }
            let diff = self.git.diff_file(
                &root,
                &checkpoint.base_rev,
                &checkpoint.head_rev,
                &score.path,
            )?;
            diffs.push((score.path.clone(), diff));
        }
        let mut existing = self.db.list_decisions(session.id)?;
        let open: Vec<(u32, String, String)> = existing
            .iter()
            .filter(|decision| decision.state == DecisionState::Pending)
            .map(|decision| {
                (
                    decision.seq,
                    decision.title.clone(),
                    decision.summary.clone(),
                )
            })
            .collect();
        let focus = artifact.provenance["focus"].as_str().unwrap_or_default();
        let prompt = decisions_prompt(&checkpoint.files, &diffs, &open, focus);
        let hidden = self.hidden_session_with(
            &session,
            SessionKind::Analysis,
            "Decision analysis",
            Some(provider),
            model.clone(),
        )?;
        let answer = self.ask_and_wait(&hidden, &prompt)?;
        let drafts = parse_decisions(&answer, &checkpoint.files)?;

        let who = match &model {
            Some(model) => format!("{} · {model}", provider.as_str()),
            None => provider.as_str().to_string(),
        };
        let now = self.now();
        let (mut opened, mut extended) = (0, 0);
        for draft in &drafts {
            // Another chapter of a thread that is still open: say so there, do not open a twin.
            let target = existing.iter().position(|earlier| {
                earlier.state != DecisionState::Superseded
                    && (draft.relates_to == Some(earlier.seq)
                        || (draft.relates_to.is_none()
                            && earlier.title.eq_ignore_ascii_case(&draft.title)))
            });
            if let Some(index) = target {
                let mut thread = existing[index].clone();
                for reference in &draft.refs {
                    if !thread.refs.contains(reference) {
                        thread.refs.push(reference.clone());
                    }
                }
                thread.version += 1;
                thread.updated_at = now.clone();
                self.db.update_decision(&thread, "seen-again")?;
                self.db.add_decision_message(&DecisionMessage {
                    id: Uuid::new_v4().to_string(),
                    decision_id: thread.id,
                    author: "agent".into(),
                    text: format!(
                        "Seen again in checkpoint #{}: {}",
                        checkpoint.seq, draft.summary
                    ),
                    code_ref: draft.refs.first().cloned(),
                    created_at: now.clone(),
                })?;
                existing[index] = thread;
                extended += 1;
                continue;
            }
            // Numbered when it is saved, so a decision opened by hand meanwhile cannot share it.
            let seq = self.next_decision_seq(session.id)?;
            let decision = Decision {
                id: DecisionId::new(),
                session_id: session.id,
                checkpoint_id: checkpoint.id,
                artifact_id: Some(artifact.id),
                seq,
                kind: draft.kind,
                title: draft.title.clone(),
                summary: draft.summary.clone(),
                context: draft.context.clone(),
                rationale: draft.rationale.clone(),
                alternatives: draft.alternatives.clone(),
                refs: draft.refs.clone(),
                state: DecisionState::Pending,
                version: 1,
                superseded_by: None,
                opened_by: who.clone(),
                created_at: now.clone(),
                updated_at: now.clone(),
            };
            self.db.insert_decision(&decision)?;
            existing.push(decision);
            opened += 1;
        }
        Ok((opened, extended))
    }

    /// Deletes everything derived for a chat: its checkpoints and, with them, the review queues,
    /// decisions and their threads, diagrams, marks, comments and set priorities. The chat itself,
    /// the code and git are untouched. It cannot be undone, so the chat's title has to be typed
    /// back, and it waits while something is still being generated.
    pub fn delete_artifacts(
        &self,
        session_id: SessionId,
        confirm: &str,
    ) -> Result<ClearedArtifacts> {
        let session = self.session(session_id)?;
        if confirm != session.title {
            return Err(Error::new(
                ErrorCode::Invalid,
                "type the title of the chat exactly to confirm",
            ));
        }
        let working = self
            .db
            .list_artifacts(session_id, None)?
            .iter()
            .any(|artifact| {
                matches!(
                    artifact.status,
                    ArtifactStatus::Queued | ArtifactStatus::Running
                )
            });
        if working {
            return Err(Error::new(
                ErrorCode::Invalid,
                "something is still being generated for this chat: wait for it to finish",
            ));
        }
        let cleared = ClearedArtifacts {
            checkpoints: self.db.list_checkpoints(session_id)?.len(),
            decisions: self.db.list_decisions(session_id)?.len(),
            diagrams: self
                .db
                .list_artifacts(session_id, Some(ArtifactKind::Flow))?
                .len(),
        };
        self.db.delete_session_checkpoints(session_id)?;
        self.sink.emit_insight(InsightEvent::Cleared { session_id });
        Ok(cleared)
    }

    /// Re-runs a failed artifact of any kind.
    pub fn retry_artifact(self: &Arc<Self>, id: ArtifactId) -> Result<Artifact> {
        let artifact = self
            .db
            .get_artifact(id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "artifact not found"))?;
        if artifact.status != ArtifactStatus::Failed {
            return Ok(artifact);
        }
        match artifact.kind {
            ArtifactKind::Decision => self.rerun_decisions(artifact),
            ArtifactKind::Flow => self.rerun_flow(artifact),
            // The review queue is computed from the code, so there is nothing to retry.
            ArtifactKind::ReviewPriority => Ok(artifact),
        }
    }

    pub fn artifacts(&self, session_id: SessionId) -> Result<Vec<Artifact>> {
        self.db.list_artifacts(session_id, None)
    }

    // ---------------------------------------------------------------- code space

    pub fn code_tree(&self, worktree_id: WorktreeId) -> Result<Vec<String>> {
        let worktree = self
            .db
            .get_worktree(worktree_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "worktree not found"))?;
        self.git.list_files(&worktree.path)
    }

    pub fn code_read(&self, worktree_id: WorktreeId, path: &str) -> Result<FileContent> {
        let worktree = self
            .db
            .get_worktree(worktree_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "worktree not found"))?;
        self.fs.read_text(&worktree.path, path)
    }

    /// Saves a file. `expected_mtime_ms` is what the editor read; a newer file on disk is a
    /// conflict and is never overwritten.
    pub fn code_write(
        &self,
        worktree_id: WorktreeId,
        path: &str,
        text: &str,
        expected_mtime_ms: Option<i64>,
    ) -> Result<i64> {
        let worktree = self
            .db
            .get_worktree(worktree_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "worktree not found"))?;
        self.fs
            .write_text(&worktree.path, path, text, expected_mtime_ms)
    }

    /// A file as it was on one side of a checkpoint (`None` when it did not exist there).
    pub fn code_file_at(
        &self,
        checkpoint_id: CheckpointId,
        path: &str,
        side: Side,
    ) -> Result<Option<String>> {
        let checkpoint = self
            .db
            .get_checkpoint(checkpoint_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "checkpoint not found"))?;
        let root = self
            .db
            .get_worktree(checkpoint.worktree_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "worktree not found"))?
            .path;
        let (rev, lookup) = match side {
            Side::Head => (&checkpoint.head_rev, path.to_string()),
            Side::Base => {
                let old = checkpoint
                    .files
                    .iter()
                    .find(|file| file.path == path)
                    .and_then(|file| file.old_path.clone());
                (
                    &checkpoint.base_rev,
                    old.unwrap_or_else(|| path.to_string()),
                )
            }
        };
        self.git.file_at(&root, rev, &lookup)
    }

    /// Records the current working tree as a manual checkpoint, unless nothing changed since
    /// the latest one.
    pub fn refresh_checkpoint(
        self: &Arc<Self>,
        session_id: SessionId,
    ) -> Result<Option<Checkpoint>> {
        let session = self.session(session_id)?;
        let root = self.worktree_path(&session)?;
        let latest = self.db.latest_checkpoint(session_id)?;
        let head = self.git.snapshot(
            &root,
            &format!("manual/{}/{}", session_id.0, Uuid::new_v4().simple()),
        )?;
        let base = match &latest {
            Some(latest) => {
                if self.git.tree_id(&root, &latest.head_rev)? == self.git.tree_id(&root, &head)? {
                    return Ok(Some(latest.clone()));
                }
                latest.head_rev.clone()
            }
            None => {
                let base = self.git.head_rev(&root)?;
                if self.git.tree_id(&root, &base)? == self.git.tree_id(&root, &head)? {
                    return Ok(None);
                }
                base
            }
        };
        let checkpoint =
            self.create_checkpoint(&session, &root, base, head, CheckpointSource::Manual, None)?;
        self.process_checkpoint(&checkpoint);
        Ok(Some(checkpoint))
    }

    /// Branches, tags and recent commits a diff can be taken against.
    pub fn code_refs(&self, session_id: SessionId) -> Result<crate::domain::GitRefs> {
        let session = self.session(session_id)?;
        self.git.list_refs(&self.worktree_path(&session)?)
    }

    /// Diffs any two revisions: `base` is a branch, tag or commit, `head` is another one or, when
    /// `None`, the working tree as it is now. With `merge_base` the base becomes the point where
    /// the two histories split, which is what a pull request shows.
    pub fn compare(
        self: &Arc<Self>,
        session_id: SessionId,
        base: &str,
        head: Option<&str>,
        merge_base: bool,
    ) -> Result<Checkpoint> {
        let session = self.session(session_id)?;
        let root = self.worktree_path(&session)?;
        let base_rev = self.git.resolve_rev(&root, base)?;
        let (head_rev, head_label, live) = match head {
            Some(spec) => (self.git.resolve_rev(&root, spec)?, spec.to_string(), false),
            None => {
                let snapshot = self.git.snapshot(
                    &root,
                    &format!("compare/{}/{}", session_id.0, Uuid::new_v4().simple()),
                )?;
                (snapshot, "working tree".to_string(), true)
            }
        };
        let base_rev = if merge_base {
            self.git.merge_base(&root, &base_rev, &head_rev)?
        } else {
            base_rev
        };
        let base_label = if merge_base {
            format!("{base} (merge base)")
        } else {
            base.to_string()
        };

        // The same comparison asked twice is the same checkpoint (and keeps its marks and notes).
        let head_tree = self.git.tree_id(&root, &head_rev)?;
        for existing in self.db.list_checkpoints(session_id)? {
            if existing.source == CheckpointSource::Compare
                && existing.base_rev == base_rev
                && existing.head_live == live
                && self.git.tree_id(&root, &existing.head_rev).ok().as_deref()
                    == Some(head_tree.as_str())
            {
                return Ok(existing);
            }
        }
        if self.git.tree_id(&root, &base_rev)? == head_tree {
            return Err(Error::new(
                ErrorCode::Invalid,
                format!("there are no differences between {base_label} and {head_label}"),
            ));
        }
        let checkpoint = self.create_checkpoint_labeled(
            &session,
            &root,
            base_rev,
            head_rev,
            CheckpointSource::Compare,
            None,
            Some(base_label),
            Some(head_label),
            live,
        )?;
        self.process_checkpoint(&checkpoint);
        Ok(checkpoint)
    }

    /// The review queue computed from the code, as it was stored when the checkpoint was made.
    pub(crate) fn computed_priority(&self, checkpoint: &Checkpoint) -> ReviewPriority {
        super::actions::stored_priority(
            self.db.as_ref(),
            checkpoint.id,
            checkpoint.session_id,
            super::engine::PRIORITY_VERSION,
        )
        .ok()
        .flatten()
        .unwrap_or_else(|| self.static_priority(checkpoint))
    }

    /// The queue the reviewer sees: the computed one with the priorities that were set on top.
    pub(crate) fn shown_priority(&self, checkpoint: &Checkpoint) -> ReviewPriority {
        let mut priority = self.computed_priority(checkpoint);
        let set = self
            .db
            .list_unit_priorities(checkpoint.id)
            .unwrap_or_default();
        super::actions::apply_overrides(&mut priority, &set);
        priority
    }

    /// Takes a priority that was set on a unit away, so it goes back to what the code says.
    pub fn reset_unit_priority(
        &self,
        checkpoint_id: CheckpointId,
        path: &str,
        name: &str,
    ) -> Result<()> {
        let checkpoint = self
            .db
            .get_checkpoint(checkpoint_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "checkpoint not found"))?;
        self.db.clear_unit_priority(checkpoint.id, path, name)?;
        self.sink.emit_insight(InsightEvent::Checkpoint {
            session_id: checkpoint.session_id,
            checkpoint_id: checkpoint.id,
        });
        Ok(())
    }

    /// Everything the review surface needs for one checkpoint (the latest by default).
    pub fn review(
        self: &Arc<Self>,
        session_id: SessionId,
        checkpoint_id: Option<CheckpointId>,
    ) -> Result<ReviewView> {
        if checkpoint_id.is_none() && self.db.latest_checkpoint(session_id)?.is_none() {
            self.refresh_checkpoint(session_id)?;
        }
        let checkpoints = self.db.list_checkpoints(session_id)?;
        let checkpoint = match checkpoint_id {
            Some(id) => checkpoints.iter().find(|item| item.id == id).cloned(),
            None => checkpoints.last().cloned(),
        };
        let Some(current) = checkpoint else {
            return Ok(ReviewView {
                checkpoints,
                checkpoint: None,
                priority: None,
                marks: Vec::new(),
                comments: Vec::new(),
                artifacts: Vec::new(),
            });
        };
        let artifacts: Vec<Artifact> = self
            .db
            .list_artifacts(session_id, None)?
            .into_iter()
            .filter(|artifact| artifact.checkpoint_id == current.id)
            .collect();
        Ok(ReviewView {
            priority: Some(self.shown_priority(&current)),
            marks: self.db.list_review_marks(current.id)?,
            comments: self.db.list_review_comments(current.id)?,
            artifacts,
            checkpoint: Some(current),
            checkpoints,
        })
    }

    /// Judges the implementation of one file. Independent from approving decisions.
    pub fn set_review_mark(
        &self,
        checkpoint_id: CheckpointId,
        path: &str,
        state: ReviewState,
    ) -> Result<ReviewMark> {
        let checkpoint = self
            .db
            .get_checkpoint(checkpoint_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "checkpoint not found"))?;
        if !checkpoint.files.iter().any(|file| file.path == path) {
            return Err(Error::new(
                ErrorCode::Invalid,
                "file is not part of this checkpoint",
            ));
        }
        let mark = ReviewMark {
            checkpoint_id,
            path: path.to_string(),
            state,
            updated_at: self.now(),
        };
        self.db.set_review_mark(&mark)?;
        Ok(mark)
    }

    pub fn add_review_comment(
        &self,
        checkpoint_id: CheckpointId,
        path: &str,
        line: Option<u32>,
        side: Side,
        text: &str,
    ) -> Result<ReviewComment> {
        let text = text.trim();
        if text.is_empty() {
            return Err(Error::new(ErrorCode::Invalid, "the comment is empty"));
        }
        if self.db.get_checkpoint(checkpoint_id)?.is_none() {
            return Err(Error::new(ErrorCode::NotFound, "checkpoint not found"));
        }
        let comment = ReviewComment {
            id: Uuid::new_v4().to_string(),
            checkpoint_id,
            path: path.to_string(),
            line,
            side: match side {
                Side::Base => "base".into(),
                Side::Head => "head".into(),
            },
            text: text.to_string(),
            author: "you".into(),
            created_at: self.now(),
        };
        self.db.add_review_comment(&comment)?;
        Ok(comment)
    }
}
