use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::adapters::git::GitCli;
use crate::adapters::pty::NativePtyHost;
use crate::adapters::sqlite::SqliteStore;
use crate::domain::{Error, ErrorCode, Result};
use crate::ports::{Git, PtyHost, Store};

pub struct AppState {
    pub git: Arc<dyn Git>,
    pub store: Arc<dyn Store>,
    pub pty: Arc<NativePtyHost>,
}

pub fn build_app_state(app: &AppHandle) -> Result<AppState> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
    let db_path: PathBuf = data_dir.join("concierge.sqlite3");
    let store = SqliteStore::open(db_path)?;
    let pty = NativePtyHost::new(app.clone());
    Ok(AppState {
        git: Arc::new(GitCli),
        store: Arc::new(store),
        pty: Arc::new(pty),
    })
}

impl AppState {
    pub fn pty_host(&self) -> &dyn PtyHost {
        self.pty.as_ref()
    }
}
