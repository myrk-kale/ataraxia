use rusqlite::Connection;

use crate::domain::time::now_rfc3339;
use crate::domain::{Error, ErrorCode, Result};

const MIGRATION_001: &str = include_str!("../../../migrations/001_workspace.sql");

pub fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
        );",
    )
    .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;

    let current: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )
        .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;

    if current < 1 {
        // 001_workspace.sql also creates schema_migrations; ignore that duplicate
        // by running the domain tables section after ensuring migrations table exists.
        conn.execute_batch(MIGRATION_001)
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
        let applied_at = now_rfc3339()?;
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, ?1)",
            [applied_at],
        )
        .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
    }

    Ok(())
}
