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
    (
        11,
        include_str!("../../../migrations/011_session_conversation.sql"),
    ),
    (12, include_str!("../../../migrations/012_autocomplete.sql")),
    (13, include_str!("../../../migrations/013_tasks.sql")),
    (14, include_str!("../../../migrations/014_search.sql")),
    (
        15,
        include_str!("../../../migrations/015_decision_turn.sql"),
    ),
    (16, include_str!("../../../migrations/016_memory.sql")),
    (
        17,
        include_str!("../../../migrations/017_session_profile.sql"),
    ),
    (18, include_str!("../../../migrations/018_workbench.sql")),
];

fn io(error: rusqlite::Error) -> Error {
    Error::new(ErrorCode::Io, error.to_string())
}

/// Before profiles were chosen per chat, one was "active" for each harness and every chat of it
/// ran under that one. Those chats keep running under it: each gets the active profile of its
/// harness. Anything unreadable in the stored profiles counts as none, as it does everywhere.
pub(super) fn carry_active_profiles(conn: &Connection) -> rusqlite::Result<()> {
    let stored: Option<String> = conn
        .query_row(
            "SELECT value FROM app_state WHERE key = ?1",
            [crate::domain::PROFILES_KEY],
            |row| row.get(0),
        )
        .ok();
    let profiles = crate::domain::Profiles::parse(stored.as_deref());
    for (provider, id) in &profiles.active {
        conn.execute(
            "UPDATE chat_sessions SET profile = ?2 WHERE provider = ?1 AND profile IS NULL",
            rusqlite::params![provider, id],
        )?;
    }
    Ok(())
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
        let tx = conn.unchecked_transaction().map_err(io)?;
        tx.execute_batch(sql).map_err(io)?;
        if *version == 14 {
            super::search::install_triggers(&tx).map_err(io)?;
        }
        if *version == 17 {
            carry_active_profiles(&tx).map_err(io)?;
        }
        tx.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
            rusqlite::params![version, applied_at],
        )
        .map_err(io)?;
        tx.commit().map_err(io)?;
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
               VALUES ('s1', 'r1', 'w1', 'fake', 'Chat 1', 'idle', 't', 't');
             INSERT INTO chat_items VALUES ('s1', 0, '{\"kind\":\"message\",\"role\":\"user\",\"id\":\"m1\",\"text\":\"existing transcript\"}');",
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
        let matching_message: String = conn
            .query_row(
                "SELECT d.item_id FROM search_fts JOIN search_documents d ON d.id = search_fts.rowid
                 WHERE search_fts MATCH 'transcript'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            matching_message, "m1",
            "existing messages are indexed at migration"
        );
    }
}
