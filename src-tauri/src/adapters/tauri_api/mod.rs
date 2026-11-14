//! Tauri commands: the driving adapter at the UI edge.

mod events;
mod insights;
mod state;

use base64::Engine as _;

use crate::app::{self, WorkspaceService, WorkspaceSnapshot};
use crate::domain::agent::{ProviderDescriptor, ProviderKind, SessionOptions};
use crate::domain::ids::{PtySessionId, RepositoryId, SessionId, TurnId, WorkspaceId, WorktreeId};
use crate::domain::{
    ChatSession, ChatSnapshot, Error, ErrorCode, ImageUpload, MessageQueue, PermissionDecision,
    PermissionRequestId, Result,
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

/// Records the repository at a folder and reads its worktrees, selecting nothing: the workspace
/// dialog uses it to add a folder before the workspace is saved.
#[tauri::command(async)]
pub fn workspace_register_repository(
    state: tauri::State<'_, AppState>,
    path: String,
) -> std::result::Result<crate::domain::Repository, String> {
    with_workspace(&state, |workspace| workspace.register_repository(path))
}

#[tauri::command]
pub fn workspace_select_workspace(
    state: tauri::State<'_, AppState>,
    workspace_id: WorkspaceId,
) -> std::result::Result<WorkspaceSnapshot, String> {
    with_workspace(&state, |workspace| workspace.select_workspace(workspace_id))
}

#[tauri::command]
pub fn workspace_create_workspace(
    state: tauri::State<'_, AppState>,
    name: String,
    repository_ids: Vec<RepositoryId>,
) -> std::result::Result<WorkspaceSnapshot, String> {
    with_workspace(&state, |workspace| {
        workspace.create_workspace(&name, &repository_ids)
    })
}

#[tauri::command]
pub fn workspace_update_workspace(
    state: tauri::State<'_, AppState>,
    workspace_id: WorkspaceId,
    name: String,
    repository_ids: Vec<RepositoryId>,
) -> std::result::Result<WorkspaceSnapshot, String> {
    with_workspace(&state, |workspace| {
        workspace.update_workspace(workspace_id, &name, &repository_ids)
    })
}

#[tauri::command]
pub fn workspace_delete_workspace(
    state: tauri::State<'_, AppState>,
    workspace_id: WorkspaceId,
) -> std::result::Result<WorkspaceSnapshot, String> {
    with_workspace(&state, |workspace| workspace.delete_workspace(workspace_id))
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

/// Deletes a chat for good: its agent is stopped first (a running turn ends with it), then its
/// messages, checkpoints, decisions and diagrams go. The code and git are untouched.
#[tauri::command(async)]
pub fn workspace_delete_session(
    state: tauri::State<'_, AppState>,
    session_id: SessionId,
) -> std::result::Result<WorkspaceSnapshot, String> {
    state.engine.stop_session_for_delete(session_id);
    with_workspace(&state, |workspace| workspace.delete_session(session_id))
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

/// Where each provider's five-hour and weekly limits stand, as far as the providers have said.
#[tauri::command]
pub fn agent_usage(state: tauri::State<'_, AppState>) -> Vec<crate::domain::ProviderUsage> {
    state.agent_runtime().usage()
}

/// Serialises the read-change-write of the stored profiles.
static PROFILES_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

fn change_profiles(
    state: &AppState,
    change: impl FnOnce(&mut crate::domain::Profiles) -> Result<()>,
) -> std::result::Result<crate::domain::Profiles, String> {
    let _guard = PROFILES_LOCK.lock();
    let stored = state
        .store
        .get_preference(crate::domain::PROFILES_KEY)
        .map_err(map_error)?;
    let mut profiles = crate::domain::Profiles::parse(stored.as_deref());
    change(&mut profiles).map_err(map_error)?;
    let json = profiles.to_json().map_err(map_error)?;
    state
        .store
        .set_preference(crate::domain::PROFILES_KEY, &json)
        .map_err(map_error)?;
    Ok(profiles)
}

/// Every launch profile and which one each harness starts with.
#[tauri::command]
pub fn profiles_list(state: tauri::State<'_, AppState>) -> crate::domain::Profiles {
    let stored = state
        .store
        .get_preference(crate::domain::PROFILES_KEY)
        .ok()
        .flatten();
    crate::domain::Profiles::parse(stored.as_deref())
}

/// Adds a profile, or changes the one with the same id.
#[tauri::command]
pub fn profile_save(
    state: tauri::State<'_, AppState>,
    profile: crate::domain::HarnessProfile,
) -> std::result::Result<crate::domain::Profiles, String> {
    change_profiles(&state, |profiles| profiles.save(profile).map(|_| ()))
}

#[tauri::command]
pub fn profile_delete(
    state: tauri::State<'_, AppState>,
    id: String,
) -> std::result::Result<crate::domain::Profiles, String> {
    change_profiles(&state, |profiles| {
        profiles.delete(&id);
        Ok(())
    })
}

/// Chooses the profile a harness starts with from now on (`None`: the default way). Chats
/// already running switch at their next message.
#[tauri::command]
pub fn profile_set_active(
    state: tauri::State<'_, AppState>,
    provider: ProviderKind,
    id: Option<String>,
) -> std::result::Result<crate::domain::Profiles, String> {
    change_profiles(&state, |profiles| {
        profiles.set_active(provider, id.as_deref())
    })
}

/// What a profile's command would run, so the form can say so before anything is saved.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileCheck {
    pub ok: bool,
    pub message: String,
}

#[tauri::command]
pub fn profile_check(command: String) -> ProfileCheck {
    use crate::adapters::agents::process::resolve_program;
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let parsed = match crate::domain::parse_command(&command, home.as_deref()) {
        Ok(parsed) => parsed,
        Err(error) => {
            return ProfileCheck {
                ok: false,
                message: error.message,
            };
        }
    };
    let settings = match parsed.env.len() {
        0 => String::new(),
        1 => " with 1 setting".to_string(),
        n => format!(" with {n} settings"),
    };
    match parsed.program {
        None => ProfileCheck {
            ok: true,
            message: format!("Starts the usual program{settings}."),
        },
        Some(word) => match resolve_program(&word) {
            Some(path) => ProfileCheck {
                ok: true,
                message: format!("Runs {}{settings}.", path.display()),
            },
            None => ProfileCheck {
                ok: false,
                message: format!("{word} was not found."),
            },
        },
    }
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
    images: Option<Vec<ImageUpload>>,
) -> std::result::Result<TurnId, String> {
    // Marks where the working tree stands, so this turn's changes become a checkpoint.
    state.engine.turn_started(session_id);
    state
        .agent_runtime()
        .prompt_with_images(&session_id, &text, images.unwrap_or_default())
        .map_err(map_error)
}

/// A picture attached to a message, as a `data:` URL the window can show.
#[tauri::command]
pub fn agent_attachment(
    state: tauri::State<'_, AppState>,
    session_id: SessionId,
    id: String,
) -> std::result::Result<String, String> {
    state
        .agent_runtime()
        .attachment(&session_id, &id)
        .map_err(map_error)
}

/// What the chat has waiting for the agent to finish.
#[tauri::command]
pub fn agent_queue(
    state: tauri::State<'_, AppState>,
    session_id: SessionId,
) -> std::result::Result<MessageQueue, String> {
    Ok(state.engine.queue(session_id))
}

/// Queues a message to go out when the agent is done, one after another.
#[tauri::command(async)]
pub fn agent_enqueue(
    state: tauri::State<'_, AppState>,
    session_id: SessionId,
    text: String,
    images: Option<Vec<ImageUpload>>,
) -> std::result::Result<MessageQueue, String> {
    state
        .engine
        .enqueue(session_id, &text, images.unwrap_or_default())
        .map_err(map_error)
}

#[tauri::command]
pub fn agent_queue_remove(
    state: tauri::State<'_, AppState>,
    session_id: SessionId,
    id: String,
) -> std::result::Result<MessageQueue, String> {
    Ok(state.engine.queue_remove(session_id, &id))
}

/// Stops the running turn and sends this queued message next, ahead of the others.
#[tauri::command(async)]
pub fn agent_queue_send_now(
    state: tauri::State<'_, AppState>,
    session_id: SessionId,
    id: String,
) -> std::result::Result<MessageQueue, String> {
    state
        .engine
        .queue_send_now(session_id, &id)
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
