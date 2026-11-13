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
