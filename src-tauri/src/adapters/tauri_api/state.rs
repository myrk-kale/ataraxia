use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::adapters::agents::{
    AgentHost, ClaudeBackend, CodexBackend, CursorBackend, FakeBackend, OpenCodeBackend, guide,
};
use crate::adapters::fs::StdFs;
use crate::adapters::git::GitCli;
use crate::adapters::pty::NativePtyHost;
use crate::adapters::sqlite::SqliteStore;
use crate::adapters::syntax::TreeSitterSyntax;
use crate::api::ApiServer;
use crate::app::engine::{Engine, TeeEventSink};
use crate::domain::agent::ProviderKind;
use crate::domain::{Error, ErrorCode, Result};

use super::events::TauriEventSink;
use crate::ports::{AgentRuntime, ApiGateway, Database, Git, PtyHost, Store};

pub struct AppState {
    pub git: Arc<dyn Git>,
    pub store: Arc<dyn Store>,
    pub sqlite: Arc<SqliteStore>,
    pub pty: Arc<NativePtyHost>,
    pub agents: Arc<AgentHost>,
    pub engine: Arc<Engine>,
    pub db_path: PathBuf,
    /// The local HTTP API agents call; `None` when it could not start.
    pub api: Option<Arc<ApiServer>>,
    /// Speech to text: the Whisper model and the engine that listens.
    pub speech: Arc<crate::adapters::speech::Recognizer>,
    /// Keeps the machine (and, as Settings says, the display) on while there is work.
    pub sleep_guard: Arc<crate::adapters::sleep::SystemSleepGuard>,
    /// The built-in browser: the window's tabs, which agents may also drive.
    pub browser: Arc<crate::app::browser::Browser>,
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
    // Without the API the agents still work; they are just not told where to find it.
    let api = ApiServer::start(Arc::clone(&database))
        .map_err(|error| eprintln!("ataraxia: could not start the local API: {error}"))
        .ok();
    // What each chat's agent is told about Ataraxia, and the guide it can read once asked. A guide
    // that cannot be written only means the agents are not pointed at one.
    let guide = guide::install(&data_dir.join("guide"))
        .map_err(|error| eprintln!("ataraxia: could not write the agent guide: {error}"))
        .ok();
    let mut host = AgentHost::new(Arc::clone(&store), tee.clone());
    if let Some(index) = guide {
        host = host.with_guide(index);
    }
    if let Some(api) = &api {
        host = host.with_api(Arc::clone(api) as Arc<dyn ApiGateway>);
    }
    let agents = Arc::new(
        host.with_insights(sqlite.clone())
            .with_handoff_dir(data_dir.join("handoffs"))
            .with_attachment_dir(data_dir.join("attachments"))
            .with_config_dir(data_dir.clone())
            .with_backend(ProviderKind::Fake, Arc::new(FakeBackend::default()))
            .with_backend(ProviderKind::OpenCode, Arc::new(OpenCodeBackend::new()))
            .with_backend(ProviderKind::Cursor, Arc::new(CursorBackend::new()))
            .with_backend(ProviderKind::Claude, Arc::new(ClaudeBackend::new()))
            .with_backend(ProviderKind::Codex, Arc::new(CodexBackend::new())),
    );
    let runtime: Arc<dyn AgentRuntime> = agents.clone();
    if let Some(api) = &api {
        api.set_runtime(&runtime);
    }
    let git: Arc<dyn Git> = Arc::new(GitCli);
    let engine = Engine::new(
        Arc::clone(&git),
        Arc::new(StdFs),
        Arc::new(TreeSitterSyntax),
        database,
        runtime,
        tauri_sink.clone(),
    );
    tee.attach(&engine);
    agents.set_reviewer(Arc::new(
        crate::app::permission_review::EngineReviewer::new(&engine),
    ));
    if let Some(api) = &api {
        api.set_anchor(Arc::clone(&engine) as Arc<dyn crate::api::Anchor>);
        api.set_code_graph(Arc::clone(&engine) as Arc<dyn crate::api::CodeGraph>);
        api.set_scheduler(Arc::clone(&engine) as Arc<dyn crate::api::Scheduling>);
        // Without its own server the files simply cannot be offered: the rest of the app works.
        match crate::files::FileServer::start() {
            Ok(files) => api.set_files(files as Arc<dyn crate::api::FileSharing>),
            Err(error) => eprintln!("ataraxia: no file server: {error}"),
        }
        api.set_sink(tauri_sink.clone() as Arc<dyn crate::ports::InsightSink>);
    }
    let browser_engine = crate::adapters::browser::TauriEngine::new(app.clone());
    let browser = crate::app::browser::Browser::with_history(
        browser_engine.clone(),
        crate::adapters::browser::TauriEngine::emit(app),
        Some(crate::app::browser_history::BrowserHistory::new(
            store.clone(),
        )),
    );
    browser_engine.set_events(browser.clone());
    browser.start_pump();
    if store
        .get_preference(super::browser::PREF_AGENTS_ALLOWED)
        .ok()
        .flatten()
        .is_some_and(|value| value == "0")
    {
        browser.set_agents_allowed(false);
    }
    if let Some(api) = &api {
        api.set_browser(browser.clone() as Arc<dyn crate::api::Browsing>);
        debug_access(api);
    }
    engine.ensure_builtin_presets()?;
    engine.recover();
    engine.start_scheduler();
    let wake_mode = store
        .get_preference(super::wake::PREF_WAKE_MODE)
        .ok()
        .flatten()
        .map(|value| crate::adapters::sleep::WakeMode::parse(&value))
        .unwrap_or(crate::adapters::sleep::WakeMode::DEFAULT);
    let sleep_guard = Arc::new(crate::adapters::sleep::SystemSleepGuard::new(wake_mode));
    engine.start_sleep_guard(sleep_guard.clone());
    Ok(AppState {
        git,
        store,
        sqlite,
        pty: Arc::new(pty),
        agents,
        engine,
        db_path,
        api,
        speech: crate::adapters::speech::Recognizer::new(data_dir.join("models")),
        sleep_guard,
        browser,
    })
}

/// In a debug build, `ATARAXIA_DEBUG_API_FILE=<path>` writes the address and a write token of the
/// local API there, for a chat that is not any agent's: how the browser is driven from a script
/// while the app runs (`curl` against `/mcp`). A release build has no such door.
#[cfg(debug_assertions)]
fn debug_access(api: &Arc<ApiServer>) {
    let Some(path) = std::env::var_os("ATARAXIA_DEBUG_API_FILE") else {
        return;
    };
    let session = crate::domain::ids::SessionId::new();
    let access = api.issue_token(session, true);
    let body = serde_json::json!({ "url": access.url, "token": access.token, "session": session.0.to_string() });
    if let Err(error) = std::fs::write(&path, body.to_string()) {
        eprintln!("ataraxia: could not write the debug API file: {error}");
    }
}

#[cfg(not(debug_assertions))]
fn debug_access(_api: &Arc<ApiServer>) {}

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
/// Read `git status` on every look. File edits do not move `HEAD` or the index, so a longer
/// interval here leaves the project tree and open file stale after an outside edit.
const STATUS_EVERY: u32 = 1;

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
