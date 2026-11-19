//! Memories and the links between them, as the [`Store`](crate::ports::Store) asks for them.

use rusqlite::{Connection, OptionalExtension, params};
use uuid::Uuid;

use crate::domain::ids::WorkspaceId;
use crate::domain::{
    Error, ErrorCode, Memory, MemoryAuthor, MemoryKind, MemoryLink, MemorySource, Relation, Result,
};

fn io(error: rusqlite::Error) -> Error {
    Error::new(ErrorCode::Io, error.to_string())
}

const COLUMNS: &str = "id, kind, workspace_id, title, body, tags_json, source, author, expires_at, created_at, updated_at";

fn bad(column: usize, what: &str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        column,
        rusqlite::types::Type::Text,
        format!("not a valid {what}").into(),
    )
}

fn map_memory(row: &rusqlite::Row<'_>) -> rusqlite::Result<Memory> {
    let kind: String = row.get(1)?;
    let workspace: Option<String> = row.get(2)?;
    let tags: String = row.get(5)?;
    let source: String = row.get(6)?;
    let author: String = row.get(7)?;
    Ok(Memory {
        id: row.get(0)?,
        kind: MemoryKind::parse(&kind).ok_or_else(|| bad(1, "memory kind"))?,
        workspace_id: workspace
            .map(|id| {
                Uuid::parse_str(&id)
                    .map(WorkspaceId)
                    .map_err(|_| bad(2, "workspace id"))
            })
            .transpose()?,
        title: row.get(3)?,
        body: row.get(4)?,
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        source: MemorySource::parse(&source).ok_or_else(|| bad(6, "memory source"))?,
        author: MemoryAuthor::parse(&author).ok_or_else(|| bad(7, "memory author"))?,
        expires_at: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn map_link(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryLink> {
    let relation: String = row.get(2)?;
    Ok(MemoryLink {
        from_id: row.get(0)?,
        to_id: row.get(1)?,
        relation: Relation::parse(&relation).ok_or_else(|| bad(2, "relation"))?,
        created_at: row.get(3)?,
    })
}

pub(super) fn all(conn: &Connection) -> Result<Vec<Memory>> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {COLUMNS} FROM memories ORDER BY updated_at DESC, rowid DESC"
        ))
        .map_err(io)?;
    let rows = statement.query_map([], map_memory).map_err(io)?;
    super::collect_rows(rows)
}

pub(super) fn links(conn: &Connection) -> Result<Vec<MemoryLink>> {
    let mut statement = conn
        .prepare("SELECT from_id, to_id, relation, created_at FROM memory_links ORDER BY created_at, rowid")
        .map_err(io)?;
    let rows = statement.query_map([], map_link).map_err(io)?;
    super::collect_rows(rows)
}

pub(super) fn get(conn: &Connection, id: &str) -> Result<Option<Memory>> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM memories WHERE id = ?1"),
        params![id],
        map_memory,
    )
    .optional()
    .map_err(io)
}

pub(super) fn put(conn: &Connection, memory: &Memory) -> Result<()> {
    let tags = serde_json::to_string(&memory.tags)
        .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
    conn.execute(
        "INSERT INTO memories (id, kind, workspace_id, title, body, tags_json, source, author,
                               expires_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET
            kind = excluded.kind, workspace_id = excluded.workspace_id, title = excluded.title,
            body = excluded.body, tags_json = excluded.tags_json, source = excluded.source,
            expires_at = excluded.expires_at, updated_at = excluded.updated_at",
        params![
            memory.id,
            memory.kind.as_str(),
            memory.workspace_id.map(|id| id.0.to_string()),
            memory.title,
            memory.body,
            tags,
            memory.source.as_str(),
            memory.author.as_str(),
            memory.expires_at,
            memory.created_at,
            memory.updated_at,
        ],
    )
    .map_err(io)?;
    Ok(())
}

pub(super) fn remove(conn: &Connection, id: &str) -> Result<bool> {
    Ok(conn
        .execute("DELETE FROM memories WHERE id = ?1", params![id])
        .map_err(io)?
        > 0)
}

pub(super) fn link_put(conn: &Connection, link: &MemoryLink) -> Result<()> {
    if link.from_id == link.to_id {
        return Err(Error::new(
            ErrorCode::Invalid,
            "a memory cannot be linked to itself",
        ));
    }
    conn.execute(
        "INSERT OR IGNORE INTO memory_links (from_id, to_id, relation, created_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![
            link.from_id,
            link.to_id,
            link.relation.as_str(),
            link.created_at
        ],
    )
    .map_err(|error| match error {
        rusqlite::Error::SqliteFailure(_, _) => {
            Error::new(ErrorCode::NotFound, "one of the memories does not exist")
        }
        other => io(other),
    })?;
    Ok(())
}

pub(super) fn link_remove(
    conn: &Connection,
    from: &str,
    to: &str,
    relation: Relation,
) -> Result<bool> {
    Ok(conn
        .execute(
            "DELETE FROM memory_links WHERE from_id = ?1 AND to_id = ?2 AND relation = ?3",
            params![from, to, relation.as_str()],
        )
        .map_err(io)?
        > 0)
}

pub(super) fn merge(conn: &Connection, into: &Memory, absorbed: &[String]) -> Result<()> {
    let tx = conn.unchecked_transaction().map_err(io)?;
    put(&tx, into)?;
    for id in absorbed.iter().filter(|id| **id != into.id) {
        // The links come over first, so deleting the memory cannot take them with it.
        tx.execute(
            "INSERT OR IGNORE INTO memory_links (from_id, to_id, relation, created_at)
             SELECT ?2, to_id, relation, created_at FROM memory_links
             WHERE from_id = ?1 AND to_id <> ?2",
            params![id, into.id],
        )
        .map_err(io)?;
        tx.execute(
            "INSERT OR IGNORE INTO memory_links (from_id, to_id, relation, created_at)
             SELECT from_id, ?2, relation, created_at FROM memory_links
             WHERE to_id = ?1 AND from_id <> ?2",
            params![id, into.id],
        )
        .map_err(io)?;
        tx.execute("DELETE FROM memories WHERE id = ?1", params![id])
            .map_err(io)?;
    }
    tx.commit().map_err(io)
}
