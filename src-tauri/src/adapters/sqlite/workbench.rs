//! The workbench's members and entries, as the [`Store`](crate::ports::Store) asks for them.

use std::collections::BTreeMap;

use rusqlite::{Connection, OptionalExtension, params};
use uuid::Uuid;

use crate::domain::ids::{SessionId, WorkspaceId};
use crate::domain::{
    Anchor, EntryKind, EntryState, Error, ErrorCode, Result, WorkbenchEntry, WorkbenchMember,
};

/// How many entries of a workspace are read back: the board is for the run in hand, not an archive.
const KEPT: i64 = 3_000;

fn io(error: rusqlite::Error) -> Error {
    Error::new(ErrorCode::Io, error.to_string())
}

fn bad(column: usize, what: &str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        column,
        rusqlite::types::Type::Text,
        format!("not a valid {what}").into(),
    )
}

fn uuid(column: usize, text: &str, what: &str) -> rusqlite::Result<Uuid> {
    Uuid::parse_str(text).map_err(|_| bad(column, what))
}

const MEMBER_COLUMNS: &str =
    "session_id, workspace_id, joined_at, base_json, cursor, seen_at, briefed";

fn map_member(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkbenchMember> {
    let session: String = row.get(0)?;
    let workspace: String = row.get(1)?;
    let base: String = row.get(3)?;
    Ok(WorkbenchMember {
        session_id: SessionId(uuid(0, &session, "session id")?),
        workspace_id: WorkspaceId(uuid(1, &workspace, "workspace id")?),
        joined_at: row.get(2)?,
        base: serde_json::from_str::<BTreeMap<String, String>>(&base).unwrap_or_default(),
        cursor: row.get(4)?,
        seen_at: row.get(5)?,
        briefed: row.get::<_, i64>(6)? != 0,
    })
}

const ENTRY_COLUMNS: &str = "seq, id, workspace_id, author_session_id, author_label, kind, state, topic, text, why, paths_json, anchor_json, to_target, reply_to, expires_at, created_at, updated_at";

fn map_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkbenchEntry> {
    let workspace: String = row.get(2)?;
    let author: Option<String> = row.get(3)?;
    let kind: String = row.get(5)?;
    let state: String = row.get(6)?;
    let paths: String = row.get(10)?;
    let anchor: Option<String> = row.get(11)?;
    Ok(WorkbenchEntry {
        seq: row.get(0)?,
        id: row.get(1)?,
        workspace_id: WorkspaceId(uuid(2, &workspace, "workspace id")?),
        author: author
            .map(|id| uuid(3, &id, "session id").map(SessionId))
            .transpose()?,
        author_label: row.get(4)?,
        kind: EntryKind::parse(&kind).ok_or_else(|| bad(5, "entry kind"))?,
        state: EntryState::parse(&state).ok_or_else(|| bad(6, "entry state"))?,
        topic: row.get(7)?,
        text: row.get(8)?,
        why: row.get(9)?,
        paths: serde_json::from_str(&paths).unwrap_or_default(),
        anchor: anchor.and_then(|json| serde_json::from_str::<Anchor>(&json).ok()),
        to: row.get(12)?,
        reply_to: row.get(13)?,
        expires_at: row.get(14)?,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
    })
}

pub(super) fn member(conn: &Connection, session: SessionId) -> Result<Option<WorkbenchMember>> {
    conn.query_row(
        &format!("SELECT {MEMBER_COLUMNS} FROM workbench_members WHERE session_id = ?1"),
        params![session.0.to_string()],
        map_member,
    )
    .optional()
    .map_err(io)
}

pub(super) fn members(conn: &Connection, workspace: WorkspaceId) -> Result<Vec<WorkbenchMember>> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {MEMBER_COLUMNS} FROM workbench_members
             WHERE workspace_id = ?1 ORDER BY joined_at, rowid"
        ))
        .map_err(io)?;
    let rows = statement
        .query_map(params![workspace.0.to_string()], map_member)
        .map_err(io)?;
    super::collect_rows(rows)
}

pub(super) fn member_put(conn: &Connection, member: &WorkbenchMember) -> Result<()> {
    let base = serde_json::to_string(&member.base)
        .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
    conn.execute(
        "INSERT INTO workbench_members (session_id, workspace_id, joined_at, base_json, cursor, seen_at, briefed)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(session_id) DO UPDATE SET
            workspace_id = excluded.workspace_id, joined_at = excluded.joined_at,
            base_json = excluded.base_json, cursor = excluded.cursor,
            seen_at = excluded.seen_at, briefed = excluded.briefed",
        params![
            member.session_id.0.to_string(),
            member.workspace_id.0.to_string(),
            member.joined_at,
            base,
            member.cursor,
            member.seen_at,
            i64::from(member.briefed),
        ],
    )
    .map_err(io)?;
    Ok(())
}

pub(super) fn member_remove(conn: &Connection, session: SessionId) -> Result<bool> {
    let removed = conn
        .execute(
            "DELETE FROM workbench_members WHERE session_id = ?1",
            params![session.0.to_string()],
        )
        .map_err(io)?;
    Ok(removed > 0)
}

pub(super) fn member_progress(
    conn: &Connection,
    session: SessionId,
    cursor: i64,
    seen_at: &str,
    briefed: bool,
) -> Result<()> {
    // The cursor only moves forward: a slow reader must not hand an agent the same news twice.
    conn.execute(
        "UPDATE workbench_members
         SET cursor = MAX(cursor, ?2), seen_at = ?3, briefed = MAX(briefed, ?4)
         WHERE session_id = ?1",
        params![session.0.to_string(), cursor, seen_at, i64::from(briefed)],
    )
    .map_err(io)?;
    Ok(())
}

pub(super) fn entry_add(conn: &Connection, entry: &WorkbenchEntry) -> Result<WorkbenchEntry> {
    let paths = serde_json::to_string(&entry.paths)
        .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
    let anchor = entry
        .anchor
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
    conn.execute(
        "INSERT INTO workbench_entries
            (id, workspace_id, author_session_id, author_label, kind, state, topic, text, why,
             paths_json, anchor_json, to_target, reply_to, expires_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            entry.id,
            entry.workspace_id.0.to_string(),
            entry.author.map(|id| id.0.to_string()),
            entry.author_label,
            entry.kind.as_str(),
            entry.state.as_str(),
            entry.topic,
            entry.text,
            entry.why,
            paths,
            anchor,
            entry.to,
            entry.reply_to,
            entry.expires_at,
            entry.created_at,
            entry.updated_at,
        ],
    )
    .map_err(io)?;
    let mut stored = entry.clone();
    stored.seq = conn.last_insert_rowid();
    Ok(stored)
}

pub(super) fn entry(conn: &Connection, id: &str) -> Result<Option<WorkbenchEntry>> {
    conn.query_row(
        &format!("SELECT {ENTRY_COLUMNS} FROM workbench_entries WHERE id = ?1"),
        params![id],
        map_entry,
    )
    .optional()
    .map_err(io)
}

pub(super) fn entries(conn: &Connection, workspace: WorkspaceId) -> Result<Vec<WorkbenchEntry>> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {ENTRY_COLUMNS} FROM (
                SELECT {ENTRY_COLUMNS} FROM workbench_entries
                WHERE workspace_id = ?1 ORDER BY seq DESC LIMIT ?2
             ) ORDER BY seq"
        ))
        .map_err(io)?;
    let rows = statement
        .query_map(params![workspace.0.to_string(), KEPT], map_entry)
        .map_err(io)?;
    super::collect_rows(rows)
}

pub(super) fn entry_update(conn: &Connection, entry: &WorkbenchEntry) -> Result<()> {
    let paths = serde_json::to_string(&entry.paths)
        .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
    let anchor = entry
        .anchor
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
    let changed = conn
        .execute(
            "UPDATE workbench_entries SET
                state = ?2, topic = ?3, text = ?4, why = ?5, paths_json = ?6, anchor_json = ?7,
                to_target = ?8, expires_at = ?9, updated_at = ?10
             WHERE id = ?1",
            params![
                entry.id,
                entry.state.as_str(),
                entry.topic,
                entry.text,
                entry.why,
                paths,
                anchor,
                entry.to,
                entry.expires_at,
                entry.updated_at,
            ],
        )
        .map_err(io)?;
    if changed == 0 {
        return Err(Error::new(ErrorCode::NotFound, "that entry is gone"));
    }
    Ok(())
}

pub(super) fn clear(conn: &Connection, workspace: WorkspaceId) -> Result<usize> {
    conn.execute(
        "DELETE FROM workbench_entries WHERE workspace_id = ?1",
        params![workspace.0.to_string()],
    )
    .map_err(io)
}
