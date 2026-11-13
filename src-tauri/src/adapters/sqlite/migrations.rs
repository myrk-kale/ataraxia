use rusqlite::Connection;

use crate::domain::time::now_rfc3339;
use crate::domain::{Error, ErrorCode, Result};

const MIGRATIONS: &[(i64, &str)] = &[
    (1, include_str!("../../../migrations/001_workspace.sql")),
    (2, include_str!("../../../migrations/002_chat_items.sql")),
    (
        3,
        include_str!("../../../migrations/003_session_settings.sql"),
    ),
    (4, include_str!("../../../migrations/004_session_agent.sql")),
    (5, include_str!("../../../migrations/005_insights.sql")),
    (6, include_str!("../../../migrations/006_diff_target.sql")),
    (
        7,
        include_str!("../../../migrations/007_decision_threads.sql"),
    ),
    (
        8,
        include_str!("../../../migrations/008_agent_requests.sql"),
    ),
    (9, include_str!("../../../migrations/009_api_audit.sql")),
    (10, include_str!("../../../migrations/010_workspaces.sql")),
];

fn io(error: rusqlite::Error) -> Error {
    Error::new(ErrorCode::Io, error.to_string())
}

/// Applies every pending migration, each in its own transaction with its version row.
pub fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
        );",
    )
    .map_err(io)?;

    let current: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )
        .map_err(io)?;

    for (version, sql) in MIGRATIONS {
        if current >= *version {
            continue;
        }
        let applied_at = now_rfc3339()?;
        let script = format!(
            "BEGIN;\n{sql}\nINSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES ({version}, '{applied_at}');\nCOMMIT;"
        );
        if let Err(error) = conn.execute_batch(&script) {
            let _ = conn.execute_batch("ROLLBACK;");
            return Err(io(error));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_repository_and_chat_that_exists_moves_into_a_workspace_of_one() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        // The database as it was before workspaces: versions 1 to 9, with a repository and a chat.
        conn.execute_batch(
            "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
        )
        .unwrap();
        for (version, sql) in MIGRATIONS.iter().filter(|(version, _)| *version <= 9) {
            conn.execute_batch(sql).unwrap();
            conn.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, 'then')",
                [version],
            )
            .unwrap();
        }
        conn.execute_batch(
            "INSERT INTO repositories VALUES ('r1', '/w/app', 'app', 't', 't');
             INSERT INTO worktrees VALUES ('w1', 'r1', '/w/app', 'main', 'abc', 't', 't');
             INSERT INTO chat_sessions (id, repository_id, worktree_id, provider, title, status, created_at, updated_at)
               VALUES ('s1', 'r1', 'w1', 'fake', 'Chat 1', 'idle', 't', 't');",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let (name, members): (String, i64) = conn
            .query_row(
                "SELECT w.name, (SELECT COUNT(*) FROM workspace_repositories m WHERE m.workspace_id = w.id)
                 FROM workspaces w",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((name.as_str(), members), ("app", 1));
        let workspace: String = conn
            .query_row(
                "SELECT workspace_id FROM chat_sessions WHERE id = 's1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            workspace, "r1",
            "the chat moved into its repository's workspace"
        );
    }
}
