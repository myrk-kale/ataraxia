use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use crate::domain::ids::{RepositoryId, WorkspaceId};
use crate::domain::{Error, ErrorCode, Result};

use super::{SqliteStore, collect_rows};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub query: String,
    pub kind: Option<String>,
    pub workspace_id: Option<WorkspaceId>,
    pub repository_id: Option<RepositoryId>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub document_id: i64,
    pub kind: String,
    pub item_id: String,
    pub session_id: Option<String>,
    pub btw_id: Option<String>,
    pub title: String,
    pub excerpt: String,
    pub workspace: Option<String>,
    pub repository: Option<String>,
    pub repository_id: Option<String>,
    pub path: Option<String>,
    pub line: Option<i64>,
    pub checkpoint_id: Option<String>,
    pub worktree_id: Option<String>,
}

fn io(error: rusqlite::Error) -> Error {
    Error::new(ErrorCode::Io, error.to_string())
}

/// Keep the corpus in the same transaction as the source write, including cascade deletes.
pub(super) fn install_triggers(conn: &Connection) -> rusqlite::Result<()> {
    for (table, changed) in [
        (
            "chat_sessions",
            "old.title IS NOT new.title OR old.kind IS NOT new.kind",
        ),
        ("chat_items", "old.payload IS NOT new.payload"),
        ("subagents", "old.payload IS NOT new.payload"),
        ("checkpoints", "old.files_json IS NOT new.files_json"),
        (
            "artifacts",
            "old.content_json IS NOT new.content_json OR old.provenance_json IS NOT new.provenance_json OR old.error IS NOT new.error",
        ),
        (
            "decisions",
            "old.title IS NOT new.title OR old.summary IS NOT new.summary OR old.context IS NOT new.context OR old.rationale IS NOT new.rationale OR old.alternatives_json IS NOT new.alternatives_json OR old.refs_json IS NOT new.refs_json",
        ),
        ("decision_messages", "old.text IS NOT new.text"),
        ("review_comments", "old.text IS NOT new.text"),
        (
            "btw_tasks",
            "old.question IS NOT new.question OR old.summary IS NOT new.summary",
        ),
        (
            "tasks",
            "old.title IS NOT new.title OR old.notes IS NOT new.notes",
        ),
    ] {
        let insert = format!(
            "INSERT INTO search_documents(source, source_rowid, kind, item_id, session_id, repository_id, title, body, path, line, checkpoint_id)
             SELECT * FROM search_sources WHERE source = '{table}' AND source_rowid = new.rowid;"
        );
        let delete = format!(
            "DELETE FROM search_documents WHERE source = '{table}' AND source_rowid = old.rowid;"
        );
        conn.execute_batch(&format!(
            "CREATE TRIGGER search_{table}_insert AFTER INSERT ON {table} BEGIN {insert} END;
             CREATE TRIGGER search_{table}_update AFTER UPDATE ON {table} WHEN {changed} BEGIN {delete} {insert} END;
             CREATE TRIGGER search_{table}_delete AFTER DELETE ON {table} BEGIN {delete} END;"
        ))?;
    }
    Ok(())
}

fn match_expression(query: &str) -> String {
    query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|term| !term.is_empty())
        .take(12)
        .map(|term| {
            let term: String = term.chars().take(80).collect();
            format!("\"{term}\"*")
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

impl SqliteStore {
    pub fn search(&self, request: &SearchRequest) -> Result<Vec<SearchResult>> {
        let expression = match_expression(&request.query);
        if expression.is_empty() {
            return Ok(Vec::new());
        }
        self.with_conn(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT d.kind, d.item_id, coalesce(b.parent_session_id, d.session_id),
                        coalesce(b.id, CASE WHEN d.kind = 'btw' THEN d.item_id END),
                        coalesce(nullif(d.title, ''), s.title, 'Message'),
                        substr(snippet(search_fts, -1, '', '', ' … ', 26), 1, 480),
                        w.name, r.name, r.id, d.path, d.line, d.checkpoint_id, d.id, cp.worktree_id
                 FROM search_fts
                 JOIN search_documents d ON d.id = search_fts.rowid
                 LEFT JOIN chat_sessions s ON s.id = d.session_id
                 LEFT JOIN btw_tasks b ON s.kind <> 'chat' AND b.session_id = s.id
                 LEFT JOIN chat_sessions parent ON parent.id = b.parent_session_id
                 LEFT JOIN workspaces w ON w.id = coalesce(parent.workspace_id, s.workspace_id)
                 LEFT JOIN repositories r ON r.id = coalesce(d.repository_id, s.repository_id)
                 LEFT JOIN checkpoints cp ON cp.id = d.checkpoint_id
                 WHERE search_fts MATCH ?1
                   AND rank MATCH 'bm25(4.0, 1.0)'
                   AND (s.kind IS NULL OR s.kind = 'chat' OR b.id IS NOT NULL)
                   AND (?2 IS NULL OR d.kind = ?2)
                   AND (?3 IS NULL OR w.id = ?3)
                   AND (?4 IS NULL OR r.id = ?4 OR
                        (d.repository_id IS NULL AND EXISTS (
                            SELECT 1 FROM session_worktrees sw
                            JOIN worktrees t ON t.id = sw.worktree_id
                            WHERE sw.session_id = coalesce(parent.id, s.id) AND t.repository_id = ?4)))
                 ORDER BY rank
                 LIMIT 60",
            ).map_err(io)?;
            let rows = stmt.query_map(params![
                expression,
                request.kind,
                request.workspace_id.map(|id| id.0.to_string()),
                request.repository_id.map(|id| id.0.to_string()),
            ], |row| {
                Ok(SearchResult {
                    kind: row.get(0)?,
                    item_id: row.get(1)?,
                    session_id: row.get(2)?,
                    btw_id: row.get(3)?,
                    title: row.get(4)?,
                    excerpt: row.get(5)?,
                    workspace: row.get(6)?,
                    repository: row.get(7)?,
                    repository_id: row.get(8)?,
                    path: row.get(9)?,
                    line: row.get(10)?,
                    checkpoint_id: row.get(11)?,
                    document_id: row.get(12)?,
                    worktree_id: row.get(13)?,
                })
            }).map_err(io)?;
            collect_rows(rows)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indexed_search_filters_scopes_and_tracks_updates_and_cascade_deletes() {
        let store = SqliteStore::open_in_memory().unwrap();
        let workspace = WorkspaceId::new();
        let repository = RepositoryId::new();
        let related = RepositoryId::new();
        store.with_conn(|conn| {
            conn.execute_batch(&format!(
                "INSERT INTO repositories VALUES
                     ('{repository}', '/app', 'app', 't', 't'),
                     ('{related}', '/api', 'api', 't', 't');
                 INSERT INTO workspaces VALUES ('{workspace}', 'Product', 't', 't');
                 INSERT INTO workspace_repositories VALUES ('{workspace}', '{repository}', 0), ('{workspace}', '{related}', 1);
                 INSERT INTO worktrees VALUES
                     ('w1', '{repository}', '/app', 'main', NULL, 't', 't'),
                     ('w2', '{related}', '/api', 'main', NULL, 't', 't');
                 INSERT INTO chat_sessions (id, repository_id, worktree_id, provider, title, status, created_at, updated_at, workspace_id)
                     VALUES ('s1', '{repository}', 'w1', 'fake', 'Worker refactor', 'idle', 't', 't', '{workspace}');
                 INSERT INTO session_worktrees VALUES ('s1', 'w2');
                 INSERT INTO checkpoints (id, session_id, repository_id, worktree_id, seq, base_rev, head_rev, source, files_json, status, created_at)
                     VALUES ('c1', 's1', '{related}', 'w2', 1, 'a', 'b', 'turn', '[]', 'ready', 't');
                 INSERT INTO artifacts (id, session_id, checkpoint_id, kind, status, content_json, created_at, updated_at)
                     VALUES ('a1', 's1', 'c1', 'flow', 'ready', '{{\"nodes\":[{{\"title\":\"Sincronização do worker\"}}]}}', 't', 't');
                 INSERT INTO chat_items VALUES ('s1', 0, '{{\"kind\":\"message\",\"id\":\"m1\",\"role\":\"user\",\"text\":\"Sincronização do worker\"}}');
                 INSERT INTO chat_items VALUES ('s1', 1, '{{\"kind\":\"tool\",\"output\":\"notsearchable\"}}');
                 INSERT INTO tasks (title, notes, created_at, updated_at) VALUES ('Sincronização', 'worker', 't', 't');",
                workspace = workspace.0, repository = repository.0, related = related.0,
            )).map_err(io)
        }).unwrap();

        let mut request = SearchRequest {
            query: "sincronizacao work".into(),
            kind: None,
            workspace_id: Some(workspace),
            repository_id: Some(related),
        };
        let matches = store.search(&request).unwrap();
        assert_eq!(matches.len(), 2);
        assert!(
            matches
                .iter()
                .any(|hit| hit.item_id == "m1" && hit.session_id.as_deref() == Some("s1"))
        );
        assert!(
            matches
                .iter()
                .any(|hit| hit.item_id == "a1" && hit.checkpoint_id.as_deref() == Some("c1"))
        );
        request.repository_id = Some(repository);
        assert_eq!(store.search(&request).unwrap()[0].item_id, "m1");

        request.repository_id = None;
        request.workspace_id = None;
        request.kind = Some("task".into());
        assert_eq!(store.search(&request).unwrap()[0].item_id, "1");
        request.query = "#1".into();
        assert_eq!(store.search(&request).unwrap()[0].item_id, "1");
        request.kind = None;
        request.query = "notsearchable".into();
        assert!(store.search(&request).unwrap().is_empty());

        store.with_conn(|conn| {
            conn.execute_batch(
                "UPDATE chat_items SET payload = json_set(payload, '$.text', 'Rewritten message') WHERE position = 0;
                 UPDATE tasks SET notes = 'Rewritten note';"
            ).map_err(io)
        }).unwrap();
        request.query = "\"sincronizacao\" (work*)".into();
        assert_eq!(store.search(&request).unwrap().len(), 1);
        request.query = "rewritten".into();
        assert_eq!(store.search(&request).unwrap().len(), 2);

        store
            .with_conn(|conn| {
                conn.execute_batch("DELETE FROM chat_sessions WHERE id = 's1'; DELETE FROM tasks;")
                    .map_err(io)
            })
            .unwrap();
        assert!(store.search(&request).unwrap().is_empty());
        request.query = "sincronizacao".into();
        assert!(store.search(&request).unwrap().is_empty());
    }
}
