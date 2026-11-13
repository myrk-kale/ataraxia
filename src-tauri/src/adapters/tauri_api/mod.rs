//! Tauri commands: the driving adapter at the UI edge.

mod events;
mod insights;
mod state;

use base64::Engine as _;

use crate::app::{self, WorkspaceService, WorkspaceSnapshot};
use crate::domain::agent::{ProviderDescriptor, ProviderKind, SessionOptions};
use crate::domain::ids::{PtySessionId, RepositoryId, SessionId, TurnId, WorktreeId};
use crate::domain::{
    ChatSession, ChatSnapshot, Error, ErrorCode, PermissionDecision, PermissionRequestId, Result,
};
use crate::ports::{PtyEnsureResponse, PtySpawnRequest};

pub use insights::*;
pub use state::{AppState, build_app_state, follow_git};

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

/// Every local branch of the repository, refreshed from git each time the selector opens.
#[tauri::command(async)]
pub fn workspace_list_branches(
    state: tauri::State<'_, AppState>,
    worktree_id: WorktreeId,
) -> std::result::Result<crate::app::workspace::BranchList, String> {
    with_workspace(&state, |workspace| workspace.list_branches(worktree_id))
}

/// Tries to move to a branch; when git refuses, the error says why and nothing changed.
#[tauri::command(async)]
pub fn workspace_select_branch(
    state: tauri::State<'_, AppState>,
    worktree_id: WorktreeId,
    name: String,
) -> std::result::Result<WorkspaceSnapshot, String> {
    with_workspace(&state, |workspace| {
        workspace.select_branch(worktree_id, &name)
    })
}

#[tauri::command]
pub fn workspace_create_session(
    state: tauri::State<'_, AppState>,
    repository_id: RepositoryId,
    worktree_id: WorktreeId,
    title: Option<String>,
    provider: Option<ProviderKind>,
) -> std::result::Result<WorkspaceSnapshot, String> {
    with_workspace(&state, |workspace| {
        workspace.create_session(
            repository_id,
            worktree_id,
            title,
            provider.unwrap_or(ProviderKind::Fake),
        )
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

#[tauri::command]
pub fn agent_list_providers(state: tauri::State<'_, AppState>) -> Vec<ProviderDescriptor> {
    state.agent_runtime().providers()
}

#[tauri::command(async)]
pub fn agent_start_session(
    state: tauri::State<'_, AppState>,
    session_id: SessionId,
) -> std::result::Result<(), String> {
    let session = state
        .store
        .get_session(session_id)
        .map_err(map_error)?
        .ok_or_else(|| Error::new(ErrorCode::NotFound, "session not found"))
        .map_err(map_error)?;
    state
        .agent_runtime()
        .start_session(&session)
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn agent_configure_session(
    state: tauri::State<'_, AppState>,
    session_id: SessionId,
    model: Option<String>,
    effort: Option<String>,
    agent: Option<String>,
) -> std::result::Result<ChatSession, String> {
    state
        .agent_runtime()
        .configure_session(&session_id, model, effort, agent)
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn agent_switch_provider(
    state: tauri::State<'_, AppState>,
    session_id: SessionId,
    provider: ProviderKind,
) -> std::result::Result<ChatSession, String> {
    state
        .agent_runtime()
        .switch_provider(&session_id, provider)
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn agent_message_subagent(
    state: tauri::State<'_, AppState>,
    session_id: SessionId,
    subagent_id: String,
    text: String,
) -> std::result::Result<(), String> {
    state
        .agent_runtime()
        .message_subagent(&session_id, &subagent_id, &text)
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn agent_get_options(
    state: tauri::State<'_, AppState>,
    session_id: SessionId,
) -> std::result::Result<SessionOptions, String> {
    state
        .agent_runtime()
        .session_options(&session_id)
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn agent_prompt(
    state: tauri::State<'_, AppState>,
    session_id: SessionId,
    text: String,
) -> std::result::Result<TurnId, String> {
    // Marks where the working tree stands, so this turn's changes become a checkpoint.
    state.engine.turn_started(session_id);
    state
        .agent_runtime()
        .prompt(&session_id, &text)
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn agent_cancel(
    state: tauri::State<'_, AppState>,
    session_id: SessionId,
    turn_id: Option<TurnId>,
) -> std::result::Result<(), String> {
    state
        .agent_runtime()
        .cancel(&session_id, turn_id.as_ref())
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn agent_resolve_permission(
    state: tauri::State<'_, AppState>,
    session_id: SessionId,
    request_id: PermissionRequestId,
    allow: bool,
) -> std::result::Result<(), String> {
    state
        .agent_runtime()
        .resolve_permission(&session_id, PermissionDecision { request_id, allow })
        .map_err(map_error)
}

#[tauri::command]
pub fn agent_get_snapshot(
    state: tauri::State<'_, AppState>,
    session_id: SessionId,
) -> std::result::Result<ChatSnapshot, String> {
    state
        .agent_runtime()
        .snapshot(&session_id)
        .map_err(map_error)
}
