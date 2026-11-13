//! SQLite persistence adapter.

mod insights;
mod migrations;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, params};

use crate::domain::agent::ProviderKind;
use crate::domain::ids::{RepositoryId, SessionId, WorkspaceId, WorktreeId};
use crate::domain::{
    ChatItem, ChatSession, Error, ErrorCode, Repository, Result, SessionKind, SessionStatus,
    Workspace, Worktree,
};
use crate::ports::Store;

use migrations::migrate;

#[derive(Debug)]
pub struct SqliteStore {
    conn: Mutex<Connection>,
}

impl SqliteStore {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self> {
        let path = path.into();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
        }
        let conn = Connection::open(&path)
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
        migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
        migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Number of API calls recorded so far (tests and diagnostics).
    pub fn audit_count(&self) -> i64 {
        self.with_conn(|conn| {
            conn.query_row("SELECT COUNT(*) FROM api_audit", [], |row| row.get(0))
                .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))
        })
        .unwrap_or(0)
    }

    fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| Error::new(ErrorCode::Io, "sqlite mutex poisoned"))?;
        f(&conn)
    }
}

impl Store for SqliteStore {
    fn health_check(&self) -> Result<()> {
        self.with_conn(|conn| {
            conn.query_row("SELECT 1", [], |row| row.get::<_, i64>(0))
                .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
            Ok(())
        })
    }

    fn upsert_repository(&self, repo: &Repository) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO repositories (id, root, name, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(root) DO UPDATE SET
                   name = excluded.name,
                   updated_at = excluded.updated_at",
                params![
                    repo.id.0.to_string(),
                    path_to_string(&repo.root),
                    repo.name,
                    repo.created_at,
                    repo.updated_at
                ],
            )
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
            Ok(())
        })
    }

    fn list_repositories(&self) -> Result<Vec<Repository>> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, root, name, created_at, updated_at
                     FROM repositories
                     ORDER BY updated_at DESC",
                )
                .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
            let rows = stmt
                .query_map([], map_repository)
                .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
            collect_rows(rows)
        })
    }

    fn get_repository(&self, id: RepositoryId) -> Result<Option<Repository>> {
        self.with_conn(|conn| {
            conn.query_row(
                "SELECT id, root, name, created_at, updated_at
                 FROM repositories WHERE id = ?1",
                params![id.0.to_string()],
                map_repository,
            )
            .optional()
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))
        })
    }

    fn find_repository_by_root(&self, root: &Path) -> Result<Option<Repository>> {
        self.with_conn(|conn| {
            conn.query_row(
                "SELECT id, root, name, created_at, updated_at
                 FROM repositories WHERE root = ?1",
                params![path_to_string(root)],
                map_repository,
            )
            .optional()
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))
        })
    }

    fn upsert_worktree(&self, worktree: &Worktree) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO worktrees
                   (id, repository_id, path, branch, head, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(repository_id, path) DO UPDATE SET
                   branch = excluded.branch,
                   head = excluded.head,
                   updated_at = excluded.updated_at",
                params![
                    worktree.id.0.to_string(),
                    worktree.repository_id.0.to_string(),
                    path_to_string(&worktree.path),
                    worktree.branch,
                    worktree.head,
                    worktree.created_at,
                    worktree.updated_at
                ],
            )
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
            Ok(())
        })
    }

    fn list_worktrees(&self, repository_id: RepositoryId) -> Result<Vec<Worktree>> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, repository_id, path, branch, head, created_at, updated_at
                     FROM worktrees
                     WHERE repository_id = ?1
                     ORDER BY path ASC",
                )
                .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
            let rows = stmt
                .query_map(params![repository_id.0.to_string()], map_worktree)
                .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
            collect_rows(rows)
        })
    }

    fn get_worktree(&self, id: WorktreeId) -> Result<Option<Worktree>> {
        self.with_conn(|conn| {
            conn.query_row(
                "SELECT id, repository_id, path, branch, head, created_at, updated_at
                 FROM worktrees WHERE id = ?1",
                params![id.0.to_string()],
                map_worktree,
            )
            .optional()
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))
        })
    }

    fn find_worktree_by_path(
        &self,
        repository_id: RepositoryId,
        path: &Path,
    ) -> Result<Option<Worktree>> {
        self.with_conn(|conn| {
            conn.query_row(
                "SELECT id, repository_id, path, branch, head, created_at, updated_at
                 FROM worktrees
                 WHERE repository_id = ?1 AND path = ?2",
                params![repository_id.0.to_string(), path_to_string(path)],
                map_worktree,
            )
            .optional()
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))
        })
    }

    fn upsert_workspace(&self, workspace: &Workspace) -> Result<()> {
        self.with_conn(|conn| {
            let io = |error: rusqlite::Error| Error::new(ErrorCode::Io, error.to_string());
            let id = workspace.id.0.to_string();
            conn.execute_batch("BEGIN").map_err(io)?;
            let outcome = (|| -> rusqlite::Result<()> {
                conn.execute(
                    "INSERT INTO workspaces (id, name, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(id) DO UPDATE SET
                       name = excluded.name,
                       updated_at = excluded.updated_at",
                    params![
                        id,
                        workspace.name,
                        workspace.created_at,
                        workspace.updated_at
                    ],
                )?;
                conn.execute(
                    "DELETE FROM workspace_repositories WHERE workspace_id = ?1",
                    params![id],
                )?;
                for (position, repository_id) in workspace.repository_ids.iter().enumerate() {
                    conn.execute(
                        "INSERT OR IGNORE INTO workspace_repositories
                           (workspace_id, repository_id, position)
                         VALUES (?1, ?2, ?3)",
                        params![id, repository_id.0.to_string(), position as i64],
                    )?;
                }
                Ok(())
            })();
            match outcome {
                Ok(()) => conn.execute_batch("COMMIT").map_err(io),
                Err(error) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    Err(io(error))
                }
            }
        })
    }

    fn list_workspaces(&self) -> Result<Vec<Workspace>> {
        self.with_conn(|conn| {
            let io = |error: rusqlite::Error| Error::new(ErrorCode::Io, error.to_string());
            let mut stmt = conn
                .prepare(
                    "SELECT id, name, created_at, updated_at FROM workspaces
                     ORDER BY updated_at DESC, name",
                )
                .map_err(io)?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })
                .map_err(io)?;
            let heads = collect_rows(rows)?;
            let mut members = conn
                .prepare(
                    "SELECT repository_id FROM workspace_repositories
                     WHERE workspace_id = ?1 ORDER BY position",
                )
                .map_err(io)?;
            let mut out = Vec::with_capacity(heads.len());
            for (id, name, created_at, updated_at) in heads {
                let ids = members
                    .query_map(params![id], |row| {
                        parse_repository_id(&row.get::<_, String>(0)?)
                    })
                    .map_err(io)?;
                out.push(Workspace {
                    id: parse_workspace_id(&id).map_err(io)?,
                    name,
                    repository_ids: collect_rows(ids)?,
                    created_at,
                    updated_at,
                });
            }
            Ok(out)
        })
    }

    fn get_workspace(&self, id: WorkspaceId) -> Result<Option<Workspace>> {
        Ok(self
            .list_workspaces()?
            .into_iter()
            .find(|item| item.id == id))
    }

    fn delete_workspace(&self, id: WorkspaceId) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "DELETE FROM workspaces WHERE id = ?1",
                params![id.0.to_string()],
            )
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
            Ok(())
        })
    }

    fn list_workspace_sessions(&self, workspace_id: WorkspaceId) -> Result<Vec<ChatSession>> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, repository_id, worktree_id, provider, title, status,
                            created_at, updated_at, last_opened_at, model, effort, agent,
                            kind, parent_session_id, workspace_id
                     FROM chat_sessions
                     WHERE workspace_id = ?1 AND kind = 'chat'
                     ORDER BY COALESCE(last_opened_at, updated_at) DESC",
                )
                .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
            let rows = stmt
                .query_map(params![workspace_id.0.to_string()], map_session)
                .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
            collect_rows(rows)
        })
    }

    fn set_session_worktrees(&self, id: SessionId, worktrees: &[WorktreeId]) -> Result<()> {
        self.with_conn(|conn| {
            let io = |error: rusqlite::Error| Error::new(ErrorCode::Io, error.to_string());
            conn.execute(
                "DELETE FROM session_worktrees WHERE session_id = ?1",
                params![id.0.to_string()],
            )
            .map_err(io)?;
            for worktree in worktrees {
                conn.execute(
                    "INSERT OR IGNORE INTO session_worktrees (session_id, worktree_id)
                     VALUES (?1, ?2)",
                    params![id.0.to_string(), worktree.0.to_string()],
                )
                .map_err(io)?;
            }
            Ok(())
        })
    }

    fn session_worktrees(&self, id: SessionId) -> Result<Vec<WorktreeId>> {
        self.with_conn(|conn| {
            let io = |error: rusqlite::Error| Error::new(ErrorCode::Io, error.to_string());
            let mut stmt = conn
                .prepare("SELECT worktree_id FROM session_worktrees WHERE session_id = ?1 ORDER BY rowid")
                .map_err(io)?;
            let rows = stmt
                .query_map(params![id.0.to_string()], |row| {
                    parse_worktree_id(&row.get::<_, String>(0)?)
                })
                .map_err(io)?;
            collect_rows(rows)
        })
    }

    fn create_session(&self, session: &ChatSession) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO chat_sessions
                   (id, repository_id, worktree_id, provider, title, status,
                    created_at, updated_at, last_opened_at, model, effort, agent,
                    kind, parent_session_id, workspace_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                params![
                    session.id.0.to_string(),
                    session.repository_id.0.to_string(),
                    session.worktree_id.0.to_string(),
                    session.provider.as_str(),
                    session.title,
                    session.status.as_str(),
                    session.created_at,
                    session.updated_at,
                    session.last_opened_at,
                    session.model,
                    session.effort,
                    session.agent,
                    session.kind.as_str(),
                    session.parent_session_id.map(|id| id.0.to_string()),
                    session.workspace_id.map(|id| id.0.to_string())
                ],
            )
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
            Ok(())
        })
    }

    fn list_sessions(&self, repository_id: RepositoryId) -> Result<Vec<ChatSession>> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, repository_id, worktree_id, provider, title, status,
                            created_at, updated_at, last_opened_at, model, effort, agent,
                            kind, parent_session_id, workspace_id
                     FROM chat_sessions
                     WHERE repository_id = ?1 AND kind = 'chat'
                     ORDER BY COALESCE(last_opened_at, updated_at) DESC",
                )
                .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
            let rows = stmt
                .query_map(params![repository_id.0.to_string()], map_session)
                .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
            collect_rows(rows)
        })
    }

    fn get_session(&self, id: SessionId) -> Result<Option<ChatSession>> {
        self.with_conn(|conn| {
            conn.query_row(
                "SELECT id, repository_id, worktree_id, provider, title, status,
                        created_at, updated_at, last_opened_at, model, effort, agent,
                            kind, parent_session_id, workspace_id
                 FROM chat_sessions WHERE id = ?1",
                params![id.0.to_string()],
                map_session,
            )
            .optional()
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))
        })
    }

    fn touch_session(&self, id: SessionId, opened_at: &str) -> Result<()> {
        self.with_conn(|conn| {
            let updated = conn
                .execute(
                    "UPDATE chat_sessions
                     SET last_opened_at = ?2, updated_at = ?2
                     WHERE id = ?1",
                    params![id.0.to_string(), opened_at],
                )
                .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
            if updated == 0 {
                return Err(Error::new(ErrorCode::NotFound, "session not found"));
            }
            Ok(())
        })
    }

    fn update_session_settings(
        &self,
        id: SessionId,
        model: Option<&str>,
        effort: Option<&str>,
        agent: Option<&str>,
        updated_at: &str,
    ) -> Result<()> {
        self.with_conn(|conn| {
            let updated = conn
                .execute(
                    "UPDATE chat_sessions
                     SET model = ?2, effort = ?3, agent = ?5, updated_at = ?4
                     WHERE id = ?1",
                    params![id.0.to_string(), model, effort, updated_at, agent],
                )
                .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
            if updated == 0 {
                return Err(Error::new(ErrorCode::NotFound, "session not found"));
            }
            Ok(())
        })
    }

    fn update_session_provider(
        &self,
        id: SessionId,
        provider: ProviderKind,
        updated_at: &str,
    ) -> Result<()> {
        self.with_conn(|conn| {
            // Model, effort and agent names are provider-specific, so they reset with it.
            let updated = conn
                .execute(
                    "UPDATE chat_sessions
                     SET provider = ?2, model = NULL, effort = NULL, agent = NULL, updated_at = ?3
                     WHERE id = ?1",
                    params![id.0.to_string(), provider.as_str(), updated_at],
                )
                .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
            if updated == 0 {
                return Err(Error::new(ErrorCode::NotFound, "session not found"));
            }
            Ok(())
        })
    }

    fn update_session_status(
        &self,
        id: SessionId,
        status: SessionStatus,
        updated_at: &str,
    ) -> Result<()> {
        self.with_conn(|conn| {
            let updated = conn
                .execute(
                    "UPDATE chat_sessions
                     SET status = ?2, updated_at = ?3
                     WHERE id = ?1",
                    params![id.0.to_string(), status.as_str(), updated_at],
                )
                .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
            if updated == 0 {
                return Err(Error::new(ErrorCode::NotFound, "session not found"));
            }
            Ok(())
        })
    }

    fn replace_chat_items(&self, id: SessionId, items: &[ChatItem]) -> Result<()> {
        let payloads = items
            .iter()
            .map(|item| {
                serde_json::to_string(item)
                    .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))
            })
            .collect::<Result<Vec<_>>>()?;
        self.with_conn(|conn| {
            let tx = conn
                .unchecked_transaction()
                .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
            tx.execute(
                "DELETE FROM chat_items WHERE session_id = ?1",
                params![id.0.to_string()],
            )
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
            for (position, payload) in payloads.iter().enumerate() {
                tx.execute(
                    "INSERT INTO chat_items (session_id, position, payload) VALUES (?1, ?2, ?3)",
                    params![id.0.to_string(), position as i64, payload],
                )
                .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
            }
            tx.commit()
                .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))
        })
    }

    fn list_chat_items(&self, id: SessionId) -> Result<Vec<ChatItem>> {
        self.with_conn(|conn| {
            let mut statement = conn
                .prepare(
                    "SELECT payload FROM chat_items WHERE session_id = ?1 ORDER BY position ASC",
                )
                .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
            let rows = statement
                .query_map(params![id.0.to_string()], |row| row.get::<_, String>(0))
                .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
            let mut items = Vec::new();
            for row in rows {
                let payload = row.map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
                items.push(
                    serde_json::from_str(&payload)
                        .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?,
                );
            }
            Ok(items)
        })
    }

    fn get_preference(&self, key: &str) -> Result<Option<String>> {
        self.with_conn(|conn| {
            conn.query_row(
                "SELECT value FROM app_state WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))
        })
    }

    fn set_preference(&self, key: &str, value: &str) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO app_state (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
            Ok(())
        })
    }
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn map_repository(row: &rusqlite::Row<'_>) -> rusqlite::Result<Repository> {
    Ok(Repository {
        id: parse_repository_id(&row.get::<_, String>(0)?)?,
        root: PathBuf::from(row.get::<_, String>(1)?),
        name: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

fn map_worktree(row: &rusqlite::Row<'_>) -> rusqlite::Result<Worktree> {
    Ok(Worktree {
        id: parse_worktree_id(&row.get::<_, String>(0)?)?,
        repository_id: parse_repository_id(&row.get::<_, String>(1)?)?,
        path: PathBuf::from(row.get::<_, String>(2)?),
        branch: row.get(3)?,
        head: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn map_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatSession> {
    let provider = row.get::<_, String>(3)?;
    let status = row.get::<_, String>(5)?;
    Ok(ChatSession {
        id: parse_session_id(&row.get::<_, String>(0)?)?,
        repository_id: parse_repository_id(&row.get::<_, String>(1)?)?,
        worktree_id: parse_worktree_id(&row.get::<_, String>(2)?)?,
        provider: ProviderKind::parse(&provider).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                3,
                rusqlite::types::Type::Text,
                Box::new(Error::new(ErrorCode::Invalid, "unknown provider")),
            )
        })?,
        title: row.get(4)?,
        status: SessionStatus::parse(&status).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                5,
                rusqlite::types::Type::Text,
                Box::new(Error::new(ErrorCode::Invalid, "unknown session status")),
            )
        })?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        last_opened_at: row.get(8)?,
        model: row.get(9)?,
        effort: row.get(10)?,
        agent: row.get(11)?,
        kind: SessionKind::parse(&row.get::<_, String>(12)?).unwrap_or_default(),
        parent_session_id: match row.get::<_, Option<String>>(13)? {
            Some(value) => Some(parse_session_id(&value)?),
            None => None,
        },
        workspace_id: match row.get::<_, Option<String>>(14)? {
            Some(value) => Some(parse_workspace_id(&value)?),
            None => None,
        },
    })
}

fn parse_repository_id(value: &str) -> rusqlite::Result<RepositoryId> {
    uuid::Uuid::parse_str(value)
        .map(RepositoryId)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
}

fn parse_workspace_id(value: &str) -> rusqlite::Result<WorkspaceId> {
    uuid::Uuid::parse_str(value)
        .map(WorkspaceId)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
}

fn parse_worktree_id(value: &str) -> rusqlite::Result<WorktreeId> {
    uuid::Uuid::parse_str(value)
        .map(WorktreeId)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
}

fn parse_session_id(value: &str) -> rusqlite::Result<SessionId> {
    uuid::Uuid::parse_str(value)
        .map(SessionId)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
}

fn collect_rows<T>(rows: impl IntoIterator<Item = rusqlite::Result<T>>) -> Result<Vec<T>> {
    rows.into_iter()
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::ids::{RepositoryId, SessionId, WorktreeId};
    use crate::domain::time::now_rfc3339;
    use crate::domain::{ChatSession, SessionStatus};
    use crate::ports::Store;

    #[test]
    fn persists_repo_worktree_and_session() {
        let store = SqliteStore::open_in_memory().expect("open");
        let now = now_rfc3339().expect("now");
        let repo = Repository {
            id: RepositoryId::new(),
            root: PathBuf::from("/tmp/demo"),
            name: "demo".into(),
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        store.upsert_repository(&repo).expect("upsert repo");
        let again = store
            .find_repository_by_root(Path::new("/tmp/demo"))
            .expect("find")
            .expect("present");
        assert_eq!(again.name, "demo");

        let worktree = Worktree {
            id: WorktreeId::new(),
            repository_id: again.id,
            path: PathBuf::from("/tmp/demo"),
            branch: Some("main".into()),
            head: Some("abc".into()),
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        store.upsert_worktree(&worktree).expect("upsert wt");

        let session = ChatSession {
            id: SessionId::new(),
            workspace_id: None,
            repository_id: again.id,
            worktree_id: worktree.id,
            provider: ProviderKind::Fake,
            title: "Chat 1".into(),
            status: SessionStatus::Idle,
            model: None,
            effort: None,
            agent: None,
            kind: SessionKind::Chat,
            parent_session_id: None,
            created_at: now.clone(),
            updated_at: now.clone(),
            last_opened_at: None,
        };
        store.create_session(&session).expect("create");
        store.touch_session(session.id, &now).expect("touch");
        let listed = store.list_sessions(again.id).expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].title, "Chat 1");
        assert!(listed[0].last_opened_at.is_some());
    }

    #[test]
    fn session_settings_and_harness_switch_are_stored() {
        let store = SqliteStore::open_in_memory().expect("open");
        let now = now_rfc3339().expect("now");
        let repo = Repository {
            id: RepositoryId::new(),
            root: PathBuf::from("/tmp/settings"),
            name: "settings".into(),
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        store.upsert_repository(&repo).expect("repo");
        let worktree = Worktree {
            id: WorktreeId::new(),
            repository_id: repo.id,
            path: PathBuf::from("/tmp/settings"),
            branch: None,
            head: None,
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        store.upsert_worktree(&worktree).expect("worktree");
        let session = ChatSession {
            id: SessionId::new(),
            workspace_id: None,
            repository_id: repo.id,
            worktree_id: worktree.id,
            provider: ProviderKind::Claude,
            title: "Chat".into(),
            status: SessionStatus::Idle,
            model: None,
            effort: None,
            agent: None,
            kind: SessionKind::Chat,
            parent_session_id: None,
            created_at: now.clone(),
            updated_at: now.clone(),
            last_opened_at: None,
        };
        store.create_session(&session).expect("session");

        store
            .update_session_settings(
                session.id,
                Some("opus"),
                Some("high"),
                Some("reviewer"),
                &now,
            )
            .expect("settings");
        let saved = store.get_session(session.id).expect("get").expect("some");
        assert_eq!(saved.model.as_deref(), Some("opus"));
        assert_eq!(saved.effort.as_deref(), Some("high"));
        assert_eq!(saved.agent.as_deref(), Some("reviewer"));

        // Names are provider-specific, so a harness switch clears all three.
        store
            .update_session_provider(session.id, ProviderKind::Codex, &now)
            .expect("switch");
        let switched = store.get_session(session.id).expect("get").expect("some");
        assert_eq!(switched.provider, ProviderKind::Codex);
        assert_eq!(
            (switched.model, switched.effort, switched.agent),
            (None, None, None)
        );
        assert!(
            store
                .update_session_provider(SessionId::new(), ProviderKind::Codex, &now)
                .is_err()
        );
    }

    #[test]
    fn chat_items_round_trip_and_are_replaced() {
        use crate::domain::ids::TurnId;
        use crate::domain::{
            ChatItem, ChatMessage, ChatRole, ToolCallId, ToolCallRecord, ToolStatus,
        };

        let store = SqliteStore::open_in_memory().expect("open");
        let now = now_rfc3339().expect("now");
        let repo = Repository {
            id: RepositoryId::new(),
            root: PathBuf::from("/tmp/items"),
            name: "items".into(),
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        store.upsert_repository(&repo).expect("repo");
        let worktree = Worktree {
            id: WorktreeId::new(),
            repository_id: repo.id,
            path: PathBuf::from("/tmp/items"),
            branch: None,
            head: None,
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        store.upsert_worktree(&worktree).expect("worktree");
        let session = ChatSession {
            id: SessionId::new(),
            workspace_id: None,
            repository_id: repo.id,
            worktree_id: worktree.id,
            provider: ProviderKind::Fake,
            title: "Chat".into(),
            status: SessionStatus::Idle,
            model: None,
            effort: None,
            agent: None,
            kind: SessionKind::Chat,
            parent_session_id: None,
            created_at: now.clone(),
            updated_at: now.clone(),
            last_opened_at: None,
        };
        store.create_session(&session).expect("session");

        let turn = TurnId::new();
        let items = vec![
            ChatItem::Message(ChatMessage {
                id: "m1".into(),
                role: ChatRole::User,
                text: "hi".into(),
                turn_id: Some(turn),
            }),
            ChatItem::Tool(ToolCallRecord {
                call_id: ToolCallId::new(),
                turn_id: turn,
                name: "bash".into(),
                input: "ls".into(),
                output: Some("a".into()),
                status: ToolStatus::Done,
            }),
        ];
        store.replace_chat_items(session.id, &items).expect("save");
        assert_eq!(store.list_chat_items(session.id).expect("load"), items);

        store
            .replace_chat_items(session.id, &items[..1])
            .expect("replace");
        assert_eq!(store.list_chat_items(session.id).expect("load").len(), 1);
    }
}
