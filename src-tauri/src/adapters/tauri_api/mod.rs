//! Tauri commands: the driving adapter at the UI edge.

mod state;

use base64::Engine as _;

use crate::app::{self, WorkspaceService, WorkspaceSnapshot};
use crate::domain::ids::{PtySessionId, RepositoryId, SessionId, WorktreeId};
use crate::domain::{Error, Result};
use crate::ports::{PtyEnsureResponse, PtySpawnRequest};

pub use state::{AppState, build_app_state};

fn map_error(error: Error) -> String {
    error.to_string()
}

fn with_workspace<T>(
    state: &AppState,
    f: impl FnOnce(WorkspaceService<'_>) -> Result<T>,
) -> std::result::Result<T, String> {
    let service = WorkspaceService {
        git: state.git.as_ref(),
        store: state.store.as_ref(),
    };
    f(service).map_err(map_error)
}

#[tauri::command]
pub fn core_status() -> String {
    app::core_status_message()
}

#[tauri::command]
pub fn workspace_bootstrap(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<WorkspaceSnapshot, String> {
    with_workspace(&state, |workspace| workspace.bootstrap())
}

#[tauri::command]
pub fn workspace_open_repository(
    state: tauri::State<'_, AppState>,
    path: String,
) -> std::result::Result<WorkspaceSnapshot, String> {
    with_workspace(&state, |workspace| workspace.open_repository(path))
}

#[tauri::command]
pub fn workspace_select_repository(
    state: tauri::State<'_, AppState>,
    repository_id: RepositoryId,
) -> std::result::Result<WorkspaceSnapshot, String> {
    with_workspace(&state, |workspace| {
        workspace.select_repository(repository_id)
    })
}

#[tauri::command]
pub fn workspace_select_worktree(
    state: tauri::State<'_, AppState>,
    worktree_id: WorktreeId,
) -> std::result::Result<WorkspaceSnapshot, String> {
    with_workspace(&state, |workspace| workspace.select_worktree(worktree_id))
}

#[tauri::command]
pub fn workspace_create_session(
    state: tauri::State<'_, AppState>,
    repository_id: RepositoryId,
    worktree_id: WorktreeId,
    title: Option<String>,
) -> std::result::Result<WorkspaceSnapshot, String> {
    with_workspace(&state, |workspace| {
        workspace.create_session(repository_id, worktree_id, title)
    })
}

#[tauri::command]
pub fn workspace_open_session(
    state: tauri::State<'_, AppState>,
    session_id: SessionId,
) -> std::result::Result<WorkspaceSnapshot, String> {
    with_workspace(&state, |workspace| workspace.open_session(session_id))
}

#[tauri::command]
pub fn terminal_ensure(
    state: tauri::State<'_, AppState>,
    worktree_id: WorktreeId,
    cwd: String,
    cols: u16,
    rows: u16,
) -> std::result::Result<PtyEnsureResponse, String> {
    state
        .pty_host()
        .ensure_session(PtySpawnRequest {
            worktree_id,
            cwd: cwd.into(),
            cols,
            rows,
        })
        .map_err(map_error)
}

#[tauri::command]
pub fn terminal_write(
    state: tauri::State<'_, AppState>,
    session_id: PtySessionId,
    data: String,
) -> std::result::Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| Error::new(crate::domain::ErrorCode::Invalid, error.to_string()))
        .map_err(map_error)?;
    state
        .pty_host()
        .write(&session_id, &bytes)
        .map_err(map_error)
}

#[tauri::command]
pub fn terminal_resize(
    state: tauri::State<'_, AppState>,
    session_id: PtySessionId,
    cols: u16,
    rows: u16,
) -> std::result::Result<(), String> {
    state
        .pty_host()
        .resize(&session_id, cols, rows)
        .map_err(map_error)
}

#[tauri::command]
pub fn terminal_kill(
    state: tauri::State<'_, AppState>,
    session_id: PtySessionId,
) -> std::result::Result<(), String> {
    state.pty_host().kill(&session_id).map_err(map_error)
}
