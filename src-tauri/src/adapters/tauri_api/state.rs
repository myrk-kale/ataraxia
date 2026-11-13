use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::adapters::agents::{
    AgentHost, ClaudeBackend, CodexBackend, FakeBackend, McpLaunch, OpenCodeBackend, guide,
};
use crate::adapters::fs::StdFs;
use crate::adapters::git::GitCli;
use crate::adapters::pty::NativePtyHost;
use crate::adapters::sqlite::SqliteStore;
use crate::adapters::syntax::TreeSitterSyntax;
use crate::app::engine::{Engine, TeeEventSink};
use crate::domain::agent::ProviderKind;
use crate::domain::{Error, ErrorCode, Result};

use super::events::TauriEventSink;
use crate::ports::{AgentRuntime, Database, Git, PtyHost, Store};

pub struct AppState {
    pub git: Arc<dyn Git>,
    pub store: Arc<dyn Store>,
    pub pty: Arc<NativePtyHost>,
    pub agents: Arc<AgentHost>,
    pub engine: Arc<Engine>,
    pub db_path: PathBuf,
}

pub fn build_app_state(app: &AppHandle) -> Result<AppState> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
    let db_path: PathBuf = data_dir.join("ataraxia.sqlite3");
    let sqlite = Arc::new(SqliteStore::open(&db_path)?);
    let store: Arc<dyn Store> = sqlite.clone();
    let database: Arc<dyn Database> = sqlite.clone();
    let pty = NativePtyHost::new(app.clone());

    let tauri_sink = Arc::new(TauriEventSink::new(app.clone()));
    let tee = Arc::new(TeeEventSink::new(tauri_sink.clone()));
    let mut claude = ClaudeBackend::new();
    if let Ok(exe) = std::env::current_exe() {
        claude = claude.with_mcp(McpLaunch {
            exe,
            db: db_path.clone(),
        });
    }
    // What each chat's agent is told about Ataraxia, and the guide it can read once asked. A guide
    // that cannot be written only means the agents are not pointed at one.
    let guide = guide::install(&data_dir.join("guide"))
        .map_err(|error| eprintln!("ataraxia: could not write the agent guide: {error}"))
        .ok();
    let mut host = AgentHost::new(Arc::clone(&store), tee.clone());
    if let Some(index) = guide {
        host = host.with_guide(index);
    }
    let agents = Arc::new(
        host.with_insights(sqlite.clone())
            .with_handoff_dir(data_dir.join("handoffs"))
            .with_backend(ProviderKind::Fake, Arc::new(FakeBackend::default()))
            .with_backend(ProviderKind::OpenCode, Arc::new(OpenCodeBackend::new()))
            .with_backend(ProviderKind::Claude, Arc::new(claude))
            .with_backend(ProviderKind::Codex, Arc::new(CodexBackend::new())),
    );
    let runtime: Arc<dyn AgentRuntime> = agents.clone();
    let git: Arc<dyn Git> = Arc::new(GitCli);
    let engine = Engine::new(
        Arc::clone(&git),
        Arc::new(StdFs),
        Arc::new(TreeSitterSyntax),
        database,
        runtime,
        tauri_sink,
    );
    tee.attach(&engine);
    engine.ensure_builtin_presets()?;
    engine.recover();
    Ok(AppState {
        git,
        store,
        pty: Arc::new(pty),
        agents,
        engine,
        db_path,
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

impl AppState {
    pub fn db_checkpoints(
        &self,
        session_id: crate::domain::ids::SessionId,
    ) -> Result<Vec<crate::domain::Checkpoint>> {
        self.engine.db.list_checkpoints(session_id)
    }
}

/// How often `HEAD` is looked at, and how many looks go by between two re-readings of the list
/// of worktrees (which costs a process).
const FOLLOW_EVERY: std::time::Duration = std::time::Duration::from_millis(800);
const REDISCOVER_EVERY: u32 = 6;
/// How many looks go by between two reads of `git status` when nothing moved in `HEAD` or the
/// index (a file made or deleted by a program that does not touch git, say): about 3 seconds.
const STATUS_EVERY: u32 = 4;

/// Whether the window is on screen. A hidden or minimized window has nobody to show changes to,
/// and the files are read again as soon as it is back.
fn window_shown(app: &AppHandle) -> bool {
    match app.get_webview_window("main") {
        Some(window) => {
            window.is_visible().unwrap_or(true) && !window.is_minimized().unwrap_or(false)
        }
        None => true,
    }
}

/// Keeps the app 1:1 with git: when a branch is switched outside the app, the app switches too,
/// and when the files of the worktree on screen change (git or not), the views over them reload.
pub fn follow_git(app: &AppHandle) {
    use tauri::Emitter;
    let app = app.clone();
    std::thread::spawn(move || {
        let mut seen = std::collections::HashMap::new();
        let mut files = std::collections::HashMap::new();
        let mut tick = 0u32;
        let mut was_hidden = false;
        loop {
            std::thread::sleep(FOLLOW_EVERY);
            tick = tick.wrapping_add(1);
            let state = app.state::<AppState>();
            let service = crate::app::workspace::WorkspaceService {
                git: state.git.as_ref(),
                store: state.store.as_ref(),
            };
            match service.follow_git(&mut seen, tick % REDISCOVER_EVERY == 0) {
                Ok(true) => {
                    if let Err(error) = app.emit(super::events::WORKSPACE_EVENT, ()) {
                        eprintln!("ataraxia: failed to emit the workspace event: {error}");
                    }
                }
                Ok(false) => {}
                Err(error) => eprintln!("ataraxia: could not follow git: {error}"),
            }
            if !window_shown(&app) {
                was_hidden = true;
                continue;
            }
            // The first look after being hidden reads the status whatever the tick.
            let check_status = was_hidden || tick % STATUS_EVERY == 0;
            was_hidden = false;
            match service.follow_files(&mut files, check_status) {
                Ok(Some(worktree)) => {
                    let payload = serde_json::json!({ "worktreeId": worktree });
                    if let Err(error) = app.emit(super::events::FILES_EVENT, payload) {
                        eprintln!("ataraxia: failed to emit the files event: {error}");
                    }
                }
                Ok(None) => {}
                Err(error) => eprintln!("ataraxia: could not follow the files: {error}"),
            }
        }
    });
}
