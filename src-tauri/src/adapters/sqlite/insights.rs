//! `InsightStore` over SQLite: checkpoints, artifacts, decisions, reviews, BTW and flow presets.

use rusqlite::{OptionalExtension, Row, params};
use serde_json::Value;
use uuid::Uuid;

use super::{SqliteStore, collect_rows, map_session};
use crate::domain::ids::{CheckpointId, RepositoryId, SessionId, WorktreeId};
use crate::domain::{
    Alternative, Artifact, ArtifactId, ArtifactKind, ArtifactStatus, BtwMode, BtwTask, BtwTaskId,
    ChangedFile, ChatSession, Checkpoint, CheckpointSource, CodeRef, Decision, DecisionCommit,
    DecisionId, DecisionKind, DecisionMessage, DecisionRevision, DecisionState, Error, ErrorCode,
    FlowPreset, FlowPresetId, Result, ReturnPolicy, ReviewComment, ReviewMark, ReviewState,
    SubagentRecord, UnitPriority,
};
use crate::ports::InsightStore;

fn db(error: rusqlite::Error) -> Error {
    Error::new(ErrorCode::Io, error.to_string())
}

fn bad(what: &str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(Error::new(ErrorCode::Invalid, what.to_string())),
    )
}

fn uuid(value: &str) -> rusqlite::Result<Uuid> {
    Uuid::parse_str(value).map_err(|_| bad("invalid uuid"))
}

fn json<T: serde::de::DeserializeOwned>(value: &str) -> rusqlite::Result<T> {
    serde_json::from_str(value).map_err(|_| bad("invalid json"))
}

fn to_json<T: serde::Serialize>(value: &T) -> Result<String> {
    serde_json::to_string(value).map_err(|error| Error::new(ErrorCode::Invalid, error.to_string()))
}

const CHECKPOINT_COLUMNS: &str = "id, session_id, repository_id, worktree_id, seq, base_rev, \
     head_rev, source, turn_id, files_json, status, created_at, base_label, head_label, head_live";

fn map_checkpoint(row: &Row<'_>) -> rusqlite::Result<Checkpoint> {
    Ok(Checkpoint {
        id: CheckpointId(uuid(&row.get::<_, String>(0)?)?),
        session_id: SessionId(uuid(&row.get::<_, String>(1)?)?),
        repository_id: RepositoryId(uuid(&row.get::<_, String>(2)?)?),
        worktree_id: WorktreeId(uuid(&row.get::<_, String>(3)?)?),
        seq: row.get(4)?,
        base_rev: row.get(5)?,
        head_rev: row.get(6)?,
        source: CheckpointSource::parse(&row.get::<_, String>(7)?)
            .ok_or_else(|| bad("checkpoint source"))?,
        turn_id: row.get(8)?,
        files: json::<Vec<ChangedFile>>(&row.get::<_, String>(9)?)?,
        status: ArtifactStatus::parse(&row.get::<_, String>(10)?)
            .ok_or_else(|| bad("checkpoint status"))?,
        created_at: row.get(11)?,
        base_label: row.get(12)?,
        head_label: row.get(13)?,
        head_live: row.get::<_, i64>(14)? != 0,
    })
}

const ARTIFACT_COLUMNS: &str = "id, session_id, checkpoint_id, kind, dedupe_key, version, status, \
     content_json, provenance_json, error, created_at, updated_at";

fn map_artifact(row: &Row<'_>) -> rusqlite::Result<Artifact> {
    Ok(Artifact {
        id: ArtifactId(uuid(&row.get::<_, String>(0)?)?),
        session_id: SessionId(uuid(&row.get::<_, String>(1)?)?),
        checkpoint_id: CheckpointId(uuid(&row.get::<_, String>(2)?)?),
        kind: ArtifactKind::parse(&row.get::<_, String>(3)?).ok_or_else(|| bad("artifact kind"))?,
        dedupe_key: row.get(4)?,
        version: row.get(5)?,
        status: ArtifactStatus::parse(&row.get::<_, String>(6)?)
            .ok_or_else(|| bad("artifact status"))?,
        content: json::<Value>(&row.get::<_, String>(7)?)?,
        provenance: json::<Value>(&row.get::<_, String>(8)?)?,
        error: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

const DECISION_COLUMNS: &str = "id, session_id, checkpoint_id, artifact_id, seq, kind, title, \
     summary, context, rationale, alternatives_json, refs_json, state, version, superseded_by, \
     created_at, updated_at, opened_by";

fn map_decision(row: &Row<'_>) -> rusqlite::Result<Decision> {
    let artifact_id = match row.get::<_, Option<String>>(3)? {
        Some(value) => Some(ArtifactId(uuid(&value)?)),
        None => None,
    };
    let superseded_by = match row.get::<_, Option<String>>(14)? {
        Some(value) => Some(DecisionId(uuid(&value)?)),
        None => None,
    };
    Ok(Decision {
        id: DecisionId(uuid(&row.get::<_, String>(0)?)?),
        session_id: SessionId(uuid(&row.get::<_, String>(1)?)?),
        checkpoint_id: CheckpointId(uuid(&row.get::<_, String>(2)?)?),
        artifact_id,
        seq: row.get(4)?,
        kind: DecisionKind::parse_lenient(&row.get::<_, String>(5)?),
        title: row.get(6)?,
        summary: row.get(7)?,
        context: row.get(8)?,
        rationale: row.get(9)?,
        alternatives: json::<Vec<Alternative>>(&row.get::<_, String>(10)?)?,
        refs: json::<Vec<CodeRef>>(&row.get::<_, String>(11)?)?,
        state: DecisionState::parse(&row.get::<_, String>(12)?)
            .ok_or_else(|| bad("decision state"))?,
        version: row.get(13)?,
        superseded_by,
        opened_by: row.get(17)?,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
    })
}

const BTW_COLUMNS: &str = "id, parent_session_id, session_id, mode, question, context_json, \
     context_text, return_policy, summary, returned_at, status, created_at, updated_at";

fn map_btw(row: &Row<'_>) -> rusqlite::Result<BtwTask> {
    Ok(BtwTask {
        id: BtwTaskId(uuid(&row.get::<_, String>(0)?)?),
        parent_session_id: SessionId(uuid(&row.get::<_, String>(1)?)?),
        session_id: SessionId(uuid(&row.get::<_, String>(2)?)?),
        mode: BtwMode::parse(&row.get::<_, String>(3)?).ok_or_else(|| bad("btw mode"))?,
        question: row.get(4)?,
        context: json::<Value>(&row.get::<_, String>(5)?)?,
        context_text: row.get(6)?,
        return_policy: ReturnPolicy::parse(&row.get::<_, String>(7)?)
            .ok_or_else(|| bad("return policy"))?,
        summary: row.get(8)?,
        returned_at: row.get(9)?,
        status: ArtifactStatus::parse(&row.get::<_, String>(10)?)
            .ok_or_else(|| bad("btw status"))?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn map_preset(row: &Row<'_>) -> rusqlite::Result<FlowPreset> {
    let repository_id = match row.get::<_, Option<String>>(1)? {
        Some(value) => Some(RepositoryId(uuid(&value)?)),
        None => None,
    };
    Ok(FlowPreset {
        id: FlowPresetId(uuid(&row.get::<_, String>(0)?)?),
        repository_id,
        name: row.get(2)?,
        prompt: row.get(3)?,
        version: row.get(4)?,
        builtin: row.get::<_, i64>(5)? != 0,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

impl InsightStore for SqliteStore {
    fn create_checkpoint(&self, cp: &Checkpoint) -> Result<()> {
        let files = to_json(&cp.files)?;
        self.with_conn(|conn| {
            conn.execute(
                &format!(
                    "INSERT INTO checkpoints ({CHECKPOINT_COLUMNS})
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)"
                ),
                params![
                    cp.id.0.to_string(),
                    cp.session_id.0.to_string(),
                    cp.repository_id.0.to_string(),
                    cp.worktree_id.0.to_string(),
                    cp.seq,
                    cp.base_rev,
                    cp.head_rev,
                    cp.source.as_str(),
                    cp.turn_id,
                    files,
                    cp.status.as_str(),
                    cp.created_at,
                    cp.base_label,
                    cp.head_label,
                    cp.head_live as i64
                ],
            )
            .map_err(db)?;
            Ok(())
        })
    }

    fn update_checkpoint_status(&self, id: CheckpointId, status: ArtifactStatus) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE checkpoints SET status = ?2 WHERE id = ?1",
                params![id.0.to_string(), status.as_str()],
            )
            .map_err(db)?;
            Ok(())
        })
    }

    fn get_checkpoint(&self, id: CheckpointId) -> Result<Option<Checkpoint>> {
        self.with_conn(|conn| {
            conn.query_row(
                &format!("SELECT {CHECKPOINT_COLUMNS} FROM checkpoints WHERE id = ?1"),
                params![id.0.to_string()],
                map_checkpoint,
            )
            .optional()
            .map_err(db)
        })
    }

    fn list_checkpoints(&self, session_id: SessionId) -> Result<Vec<Checkpoint>> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {CHECKPOINT_COLUMNS} FROM checkpoints
                     WHERE session_id = ?1 ORDER BY seq ASC"
                ))
                .map_err(db)?;
            let rows = stmt
                .query_map(params![session_id.0.to_string()], map_checkpoint)
                .map_err(db)?;
            collect_rows(rows)
        })
    }

    fn latest_checkpoint(&self, session_id: SessionId) -> Result<Option<Checkpoint>> {
        self.with_conn(|conn| {
            conn.query_row(
                &format!(
                    "SELECT {CHECKPOINT_COLUMNS} FROM checkpoints
                     WHERE session_id = ?1 ORDER BY seq DESC LIMIT 1"
                ),
                params![session_id.0.to_string()],
                map_checkpoint,
            )
            .optional()
            .map_err(db)
        })
    }

    fn ensure_artifact(&self, artifact: &Artifact) -> Result<(Artifact, bool)> {
        let content = to_json(&artifact.content)?;
        let provenance = to_json(&artifact.provenance)?;
        self.with_conn(|conn| {
            let inserted = conn
                .execute(
                    &format!(
                        "INSERT OR IGNORE INTO artifacts ({ARTIFACT_COLUMNS})
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)"
                    ),
                    params![
                        artifact.id.0.to_string(),
                        artifact.session_id.0.to_string(),
                        artifact.checkpoint_id.0.to_string(),
                        artifact.kind.as_str(),
                        artifact.dedupe_key,
                        artifact.version,
                        artifact.status.as_str(),
                        content,
                        provenance,
                        artifact.error,
                        artifact.created_at,
                        artifact.updated_at
                    ],
                )
                .map_err(db)?;
            let stored = conn
                .query_row(
                    &format!(
                        "SELECT {ARTIFACT_COLUMNS} FROM artifacts
                         WHERE checkpoint_id = ?1 AND kind = ?2 AND dedupe_key = ?3"
                    ),
                    params![
                        artifact.checkpoint_id.0.to_string(),
                        artifact.kind.as_str(),
                        artifact.dedupe_key
                    ],
                    map_artifact,
                )
                .map_err(db)?;
            Ok((stored, inserted > 0))
        })
    }

    fn update_artifact(
        &self,
        id: ArtifactId,
        status: ArtifactStatus,
        content: Option<&Value>,
        provenance: Option<&Value>,
        error: Option<&str>,
        updated_at: &str,
    ) -> Result<()> {
        let content = content.map(to_json).transpose()?;
        let provenance = provenance.map(to_json).transpose()?;
        self.with_conn(|conn| {
            let changed = conn
                .execute(
                    "UPDATE artifacts SET status = ?2,
                       content_json = COALESCE(?3, content_json),
                       provenance_json = COALESCE(?4, provenance_json),
                       error = ?5, updated_at = ?6
                     WHERE id = ?1",
                    params![
                        id.0.to_string(),
                        status.as_str(),
                        content,
                        provenance,
                        error,
                        updated_at
                    ],
                )
                .map_err(db)?;
            if changed == 0 {
                return Err(Error::new(ErrorCode::NotFound, "artifact not found"));
            }
            Ok(())
        })
    }

    fn get_artifact(&self, id: ArtifactId) -> Result<Option<Artifact>> {
        self.with_conn(|conn| {
            conn.query_row(
                &format!("SELECT {ARTIFACT_COLUMNS} FROM artifacts WHERE id = ?1"),
                params![id.0.to_string()],
                map_artifact,
            )
            .optional()
            .map_err(db)
        })
    }

    fn list_artifacts(
        &self,
        session_id: SessionId,
        kind: Option<ArtifactKind>,
    ) -> Result<Vec<Artifact>> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {ARTIFACT_COLUMNS} FROM artifacts
                     WHERE session_id = ?1 AND (?2 IS NULL OR kind = ?2)
                     ORDER BY created_at DESC"
                ))
                .map_err(db)?;
            let rows = stmt
                .query_map(
                    params![session_id.0.to_string(), kind.map(|kind| kind.as_str())],
                    map_artifact,
                )
                .map_err(db)?;
            collect_rows(rows)
        })
    }

    fn mark_artifacts_stale(
        &self,
        session_id: SessionId,
        kind: ArtifactKind,
        keep: CheckpointId,
        updated_at: &str,
    ) -> Result<usize> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE artifacts SET status = 'stale', updated_at = ?4
                 WHERE session_id = ?1 AND kind = ?2 AND checkpoint_id != ?3 AND status = 'ready'",
                params![
                    session_id.0.to_string(),
                    kind.as_str(),
                    keep.0.to_string(),
                    updated_at
                ],
            )
            .map_err(db)
        })
    }

    fn interrupted_artifacts(&self) -> Result<Vec<Artifact>> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {ARTIFACT_COLUMNS} FROM artifacts
                     WHERE status IN ('queued', 'running')"
                ))
                .map_err(db)?;
            let rows = stmt.query_map([], map_artifact).map_err(db)?;
            collect_rows(rows)
        })
    }

    fn insert_decision(&self, d: &Decision) -> Result<()> {
        let alternatives = to_json(&d.alternatives)?;
        let refs = to_json(&d.refs)?;
        self.with_conn(|conn| {
            conn.execute(
                &format!(
                    "INSERT INTO decisions ({DECISION_COLUMNS})
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)"
                ),
                params![
                    d.id.0.to_string(),
                    d.session_id.0.to_string(),
                    d.checkpoint_id.0.to_string(),
                    d.artifact_id.map(|id| id.0.to_string()),
                    d.seq,
                    d.kind.as_str(),
                    d.title,
                    d.summary,
                    d.context,
                    d.rationale,
                    alternatives,
                    refs,
                    d.state.as_str(),
                    d.version,
                    d.superseded_by.map(|id| id.0.to_string()),
                    d.created_at,
                    d.updated_at,
                    d.opened_by
                ],
            )
            .map_err(db)?;
            conn.execute(
                "INSERT INTO decision_revisions (decision_id, version, snapshot_json, reason, created_at)
                 VALUES (?1, ?2, ?3, 'created', ?4)",
                params![
                    d.id.0.to_string(),
                    d.version,
                    to_json(d)?,
                    d.created_at
                ],
            )
            .map_err(db)?;
            Ok(())
        })
    }

    /// Stores the new state and keeps the previous one in the revision history.
    fn update_decision(&self, d: &Decision, reason: &str) -> Result<()> {
        let alternatives = to_json(&d.alternatives)?;
        let refs = to_json(&d.refs)?;
        let snapshot = to_json(d)?;
        self.with_conn(|conn| {
            let changed = conn
                .execute(
                    "UPDATE decisions SET kind = ?2, title = ?3, summary = ?4, context = ?5,
                       rationale = ?6, alternatives_json = ?7, refs_json = ?8, state = ?9,
                       version = ?10, superseded_by = ?11, updated_at = ?12
                     WHERE id = ?1",
                    params![
                        d.id.0.to_string(),
                        d.kind.as_str(),
                        d.title,
                        d.summary,
                        d.context,
                        d.rationale,
                        alternatives,
                        refs,
                        d.state.as_str(),
                        d.version,
                        d.superseded_by.map(|id| id.0.to_string()),
                        d.updated_at
                    ],
                )
                .map_err(db)?;
            if changed == 0 {
                return Err(Error::new(ErrorCode::NotFound, "decision not found"));
            }
            conn.execute(
                "INSERT OR REPLACE INTO decision_revisions
                   (decision_id, version, snapshot_json, reason, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    d.id.0.to_string(),
                    d.version,
                    snapshot,
                    reason,
                    d.updated_at
                ],
            )
            .map_err(db)?;
            Ok(())
        })
    }

    fn get_decision(&self, id: DecisionId) -> Result<Option<Decision>> {
        self.with_conn(|conn| {
            conn.query_row(
                &format!("SELECT {DECISION_COLUMNS} FROM decisions WHERE id = ?1"),
                params![id.0.to_string()],
                map_decision,
            )
            .optional()
            .map_err(db)
        })
    }

    fn list_decisions(&self, session_id: SessionId) -> Result<Vec<Decision>> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {DECISION_COLUMNS} FROM decisions
                     WHERE session_id = ?1 ORDER BY created_at ASC, seq ASC"
                ))
                .map_err(db)?;
            let rows = stmt
                .query_map(params![session_id.0.to_string()], map_decision)
                .map_err(db)?;
            collect_rows(rows)
        })
    }

    fn decision_revisions(&self, id: DecisionId) -> Result<Vec<DecisionRevision>> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT decision_id, version, snapshot_json, reason, created_at
                     FROM decision_revisions WHERE decision_id = ?1 ORDER BY version ASC",
                )
                .map_err(db)?;
            let rows = stmt
                .query_map(params![id.0.to_string()], |row| {
                    Ok(DecisionRevision {
                        decision_id: DecisionId(uuid(&row.get::<_, String>(0)?)?),
                        version: row.get(1)?,
                        snapshot: json::<Value>(&row.get::<_, String>(2)?)?,
                        reason: row.get(3)?,
                        created_at: row.get(4)?,
                    })
                })
                .map_err(db)?;
            collect_rows(rows)
        })
    }

    fn add_decision_commit(&self, commit: &DecisionCommit) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT OR REPLACE INTO decision_commits
                   (decision_id, rev, short, subject, author, committed_at, note, linked_by, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    commit.decision_id.0.to_string(),
                    commit.rev,
                    commit.short,
                    commit.subject,
                    commit.author,
                    commit.committed_at,
                    commit.note,
                    commit.linked_by,
                    commit.created_at
                ],
            )
            .map_err(db)?;
            Ok(())
        })
    }

    fn remove_decision_commit(&self, id: DecisionId, rev: &str) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "DELETE FROM decision_commits WHERE decision_id = ?1 AND rev = ?2",
                params![id.0.to_string(), rev],
            )
            .map_err(db)?;
            Ok(())
        })
    }

    fn list_decision_commits(&self, id: DecisionId) -> Result<Vec<DecisionCommit>> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT decision_id, rev, short, subject, author, committed_at, note, linked_by, created_at
                     FROM decision_commits WHERE decision_id = ?1 ORDER BY created_at ASC",
                )
                .map_err(db)?;
            let rows = stmt
                .query_map(params![id.0.to_string()], |row| {
                    Ok(DecisionCommit {
                        decision_id: DecisionId(uuid(&row.get::<_, String>(0)?)?),
                        rev: row.get(1)?,
                        short: row.get(2)?,
                        subject: row.get(3)?,
                        author: row.get(4)?,
                        committed_at: row.get(5)?,
                        note: row.get(6)?,
                        linked_by: row.get(7)?,
                        created_at: row.get(8)?,
                    })
                })
                .map_err(db)?;
            collect_rows(rows)
        })
    }

    fn add_decision_message(&self, message: &DecisionMessage) -> Result<()> {
        let code_ref = message.code_ref.as_ref().map(to_json).transpose()?;
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO decision_messages (id, decision_id, author, text, code_ref_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    message.id,
                    message.decision_id.0.to_string(),
                    message.author,
                    message.text,
                    code_ref,
                    message.created_at
                ],
            )
            .map_err(db)?;
            Ok(())
        })
    }

    fn list_decision_messages(&self, id: DecisionId) -> Result<Vec<DecisionMessage>> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, decision_id, author, text, code_ref_json, created_at
                     FROM decision_messages WHERE decision_id = ?1
                     ORDER BY created_at ASC, rowid ASC",
                )
                .map_err(db)?;
            let rows = stmt
                .query_map(params![id.0.to_string()], |row| {
                    let code_ref = match row.get::<_, Option<String>>(4)? {
                        Some(value) => Some(json::<CodeRef>(&value)?),
                        None => None,
                    };
                    Ok(DecisionMessage {
                        id: row.get(0)?,
                        decision_id: DecisionId(uuid(&row.get::<_, String>(1)?)?),
                        author: row.get(2)?,
                        text: row.get(3)?,
                        code_ref,
                        created_at: row.get(5)?,
                    })
                })
                .map_err(db)?;
            collect_rows(rows)
        })
    }

    fn set_review_mark(&self, mark: &ReviewMark) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO review_marks (checkpoint_id, path, state, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(checkpoint_id, path) DO UPDATE SET
                   state = excluded.state, updated_at = excluded.updated_at",
                params![
                    mark.checkpoint_id.0.to_string(),
                    mark.path,
                    mark.state.as_str(),
                    mark.updated_at
                ],
            )
            .map_err(db)?;
            Ok(())
        })
    }

    fn list_review_marks(&self, id: CheckpointId) -> Result<Vec<ReviewMark>> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT checkpoint_id, path, state, updated_at
                     FROM review_marks WHERE checkpoint_id = ?1 ORDER BY path",
                )
                .map_err(db)?;
            let rows = stmt
                .query_map(params![id.0.to_string()], |row| {
                    Ok(ReviewMark {
                        checkpoint_id: CheckpointId(uuid(&row.get::<_, String>(0)?)?),
                        path: row.get(1)?,
                        state: ReviewState::parse(&row.get::<_, String>(2)?)
                            .ok_or_else(|| bad("review state"))?,
                        updated_at: row.get(3)?,
                    })
                })
                .map_err(db)?;
            collect_rows(rows)
        })
    }

    fn add_review_comment(&self, comment: &ReviewComment) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO review_comments (id, checkpoint_id, path, line, side, text, created_at, author)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    comment.id,
                    comment.checkpoint_id.0.to_string(),
                    comment.path,
                    comment.line,
                    comment.side,
                    comment.text,
                    comment.created_at,
                    comment.author
                ],
            )
            .map_err(db)?;
            Ok(())
        })
    }

    fn list_review_comments(&self, id: CheckpointId) -> Result<Vec<ReviewComment>> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, checkpoint_id, path, line, side, text, created_at, author
                     FROM review_comments WHERE checkpoint_id = ?1
                     ORDER BY path, line, created_at",
                )
                .map_err(db)?;
            let rows = stmt
                .query_map(params![id.0.to_string()], |row| {
                    Ok(ReviewComment {
                        id: row.get(0)?,
                        checkpoint_id: CheckpointId(uuid(&row.get::<_, String>(1)?)?),
                        path: row.get(2)?,
                        line: row.get(3)?,
                        side: row.get(4)?,
                        text: row.get(5)?,
                        created_at: row.get(6)?,
                        author: row.get(7)?,
                    })
                })
                .map_err(db)?;
            collect_rows(rows)
        })
    }

    fn delete_session_checkpoints(&self, session_id: SessionId) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "DELETE FROM checkpoints WHERE session_id = ?1",
                params![session_id.0.to_string()],
            )
            .map_err(db)?;
            Ok(())
        })
    }

    fn set_unit_priority(&self, priority: &UnitPriority) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT OR REPLACE INTO unit_priority
                   (checkpoint_id, path, name, score, reason, set_by, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    priority.checkpoint_id.0.to_string(),
                    priority.path,
                    priority.name,
                    priority.score,
                    priority.reason,
                    priority.set_by,
                    priority.updated_at
                ],
            )
            .map_err(db)?;
            Ok(())
        })
    }

    fn clear_unit_priority(
        &self,
        checkpoint_id: CheckpointId,
        path: &str,
        name: &str,
    ) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "DELETE FROM unit_priority WHERE checkpoint_id = ?1 AND path = ?2 AND name = ?3",
                params![checkpoint_id.0.to_string(), path, name],
            )
            .map_err(db)?;
            Ok(())
        })
    }

    fn list_unit_priorities(&self, checkpoint_id: CheckpointId) -> Result<Vec<UnitPriority>> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT checkpoint_id, path, name, score, reason, set_by, updated_at
                     FROM unit_priority WHERE checkpoint_id = ?1 ORDER BY updated_at ASC",
                )
                .map_err(db)?;
            let rows = stmt
                .query_map(params![checkpoint_id.0.to_string()], |row| {
                    Ok(UnitPriority {
                        checkpoint_id: CheckpointId(uuid(&row.get::<_, String>(0)?)?),
                        path: row.get(1)?,
                        name: row.get(2)?,
                        score: row.get(3)?,
                        reason: row.get(4)?,
                        set_by: row.get(5)?,
                        updated_at: row.get(6)?,
                    })
                })
                .map_err(db)?;
            collect_rows(rows)
        })
    }

    fn insert_btw_task(&self, task: &BtwTask) -> Result<()> {
        let context = to_json(&task.context)?;
        self.with_conn(|conn| {
            conn.execute(
                &format!(
                    "INSERT INTO btw_tasks ({BTW_COLUMNS})
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)"
                ),
                params![
                    task.id.0.to_string(),
                    task.parent_session_id.0.to_string(),
                    task.session_id.0.to_string(),
                    task.mode.as_str(),
                    task.question,
                    context,
                    task.context_text,
                    task.return_policy.as_str(),
                    task.summary,
                    task.returned_at,
                    task.status.as_str(),
                    task.created_at,
                    task.updated_at
                ],
            )
            .map_err(db)?;
            Ok(())
        })
    }

    fn update_btw_task(
        &self,
        id: BtwTaskId,
        status: ArtifactStatus,
        summary: Option<&str>,
        returned_at: Option<&str>,
        updated_at: &str,
    ) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE btw_tasks SET status = ?2,
                   summary = COALESCE(?3, summary),
                   returned_at = COALESCE(?4, returned_at),
                   updated_at = ?5
                 WHERE id = ?1",
                params![
                    id.0.to_string(),
                    status.as_str(),
                    summary,
                    returned_at,
                    updated_at
                ],
            )
            .map_err(db)?;
            Ok(())
        })
    }

    fn get_btw_task(&self, id: BtwTaskId) -> Result<Option<BtwTask>> {
        self.with_conn(|conn| {
            conn.query_row(
                &format!("SELECT {BTW_COLUMNS} FROM btw_tasks WHERE id = ?1"),
                params![id.0.to_string()],
                map_btw,
            )
            .optional()
            .map_err(db)
        })
    }

    fn btw_task_for_session(&self, session_id: SessionId) -> Result<Option<BtwTask>> {
        self.with_conn(|conn| {
            conn.query_row(
                &format!("SELECT {BTW_COLUMNS} FROM btw_tasks WHERE session_id = ?1"),
                params![session_id.0.to_string()],
                map_btw,
            )
            .optional()
            .map_err(db)
        })
    }

    fn list_btw_tasks(&self, parent: SessionId) -> Result<Vec<BtwTask>> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {BTW_COLUMNS} FROM btw_tasks
                     WHERE parent_session_id = ?1 ORDER BY created_at DESC"
                ))
                .map_err(db)?;
            let rows = stmt
                .query_map(params![parent.0.to_string()], map_btw)
                .map_err(db)?;
            collect_rows(rows)
        })
    }

    fn list_flow_presets(&self, repository_id: RepositoryId) -> Result<Vec<FlowPreset>> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, repository_id, name, prompt, version, builtin, created_at, updated_at
                     FROM flow_presets
                     WHERE repository_id IS NULL OR repository_id = ?1
                     ORDER BY builtin DESC, created_at ASC, name ASC",
                )
                .map_err(db)?;
            let rows = stmt
                .query_map(params![repository_id.0.to_string()], map_preset)
                .map_err(db)?;
            collect_rows(rows)
        })
    }

    fn get_flow_preset(&self, id: FlowPresetId) -> Result<Option<FlowPreset>> {
        self.with_conn(|conn| {
            conn.query_row(
                "SELECT id, repository_id, name, prompt, version, builtin, created_at, updated_at
                 FROM flow_presets WHERE id = ?1",
                params![id.0.to_string()],
                map_preset,
            )
            .optional()
            .map_err(db)
        })
    }

    fn upsert_flow_preset(&self, preset: &FlowPreset) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO flow_presets
                   (id, repository_id, name, prompt, version, builtin, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(id) DO UPDATE SET
                   name = excluded.name, prompt = excluded.prompt,
                   version = excluded.version, updated_at = excluded.updated_at",
                params![
                    preset.id.0.to_string(),
                    preset.repository_id.map(|id| id.0.to_string()),
                    preset.name,
                    preset.prompt,
                    preset.version,
                    preset.builtin as i64,
                    preset.created_at,
                    preset.updated_at
                ],
            )
            .map_err(db)?;
            Ok(())
        })
    }

    fn delete_flow_preset(&self, id: FlowPresetId) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "DELETE FROM flow_presets WHERE id = ?1 AND builtin = 0",
                params![id.0.to_string()],
            )
            .map_err(db)?;
            Ok(())
        })
    }

    fn list_child_sessions(&self, parent: SessionId) -> Result<Vec<ChatSession>> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, repository_id, worktree_id, provider, title, status,
                            created_at, updated_at, last_opened_at, model, effort, agent,
                            kind, parent_session_id
                     FROM chat_sessions WHERE parent_session_id = ?1
                     ORDER BY created_at DESC",
                )
                .map_err(db)?;
            let rows = stmt
                .query_map(params![parent.0.to_string()], map_session)
                .map_err(db)?;
            collect_rows(rows)
        })
    }

    fn replace_subagents(&self, session_id: SessionId, records: &[SubagentRecord]) -> Result<()> {
        let mut payloads = Vec::with_capacity(records.len());
        for record in records {
            payloads.push((record.id.clone(), to_json(record)?));
        }
        self.with_conn(|conn| {
            let tx = conn.unchecked_transaction().map_err(db)?;
            tx.execute(
                "DELETE FROM subagents WHERE session_id = ?1",
                params![session_id.0.to_string()],
            )
            .map_err(db)?;
            for (id, payload) in payloads {
                tx.execute(
                    "INSERT INTO subagents (session_id, subagent_id, payload) VALUES (?1, ?2, ?3)",
                    params![session_id.0.to_string(), id, payload],
                )
                .map_err(db)?;
            }
            tx.commit().map_err(db)?;
            Ok(())
        })
    }

    fn list_subagents(&self, session_id: SessionId) -> Result<Vec<SubagentRecord>> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare("SELECT payload FROM subagents WHERE session_id = ?1 ORDER BY rowid ASC")
                .map_err(db)?;
            let rows = stmt
                .query_map(params![session_id.0.to_string()], |row| {
                    json::<SubagentRecord>(&row.get::<_, String>(0)?)
                })
                .map_err(db)?;
            collect_rows(rows)
        })
    }

    fn audit_mcp(
        &self,
        at: &str,
        tool: &str,
        scope: Option<&str>,
        write: bool,
        ok: bool,
        detail: &str,
    ) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO mcp_audit (at, tool, scope, write, ok, detail)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![at, tool, scope, write as i64, ok as i64, detail],
            )
            .map_err(db)?;
            Ok(())
        })
    }
}
