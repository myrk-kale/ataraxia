use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::adapters::agents::{
    AgentHost, ClaudeBackend, CodexBackend, FakeBackend, OpenCodeBackend,
};
use crate::adapters::git::GitCli;
use crate::adapters::pty::NativePtyHost;
use crate::adapters::sqlite::SqliteStore;
use crate::domain::agent::ProviderKind;
use crate::domain::{Error, ErrorCode, Result};

use super::events::TauriEventSink;
use crate::ports::{AgentRuntime, Git, PtyHost, Store};

pub struct AppState {
    pub git: Arc<dyn Git>,
    pub store: Arc<dyn Store>,
    pub pty: Arc<NativePtyHost>,
    pub agents: Arc<AgentHost>,
}

pub fn build_app_state(app: &AppHandle) -> Result<AppState> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
    let db_path: PathBuf = data_dir.join("ataraxia.sqlite3");
    let store: Arc<dyn Store> = Arc::new(SqliteStore::open(db_path)?);
    let pty = NativePtyHost::new(app.clone());
    let sink = Arc::new(TauriEventSink::new(app.clone()));
    let agents = AgentHost::new(Arc::clone(&store), sink)
        .with_backend(ProviderKind::Fake, Arc::new(FakeBackend::default()))
        .with_backend(ProviderKind::OpenCode, Arc::new(OpenCodeBackend::new()))
        .with_backend(ProviderKind::Claude, Arc::new(ClaudeBackend::new()))
        .with_backend(ProviderKind::Codex, Arc::new(CodexBackend::new()));
    Ok(AppState {
        git: Arc::new(GitCli),
        store,
        pty: Arc::new(pty),
        agents: Arc::new(agents),
    })
}

impl AppState {
    pub fn pty_host(&self) -> &dyn PtyHost {
        self.pty.as_ref()
    }

    pub fn agent_runtime(&self) -> &dyn AgentRuntime {
        self.agents.as_ref()
    }
}
