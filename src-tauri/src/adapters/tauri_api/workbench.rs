//! Commands for the workbench screen: what the agents posted and who is touching what, and what
//! the developer does about it. They run off the main thread: reading a board asks git.

use super::{AppState, map_error};
use crate::app::workbench::{Resolution, WorkbenchView};
use crate::domain::WorkbenchEntry;
use crate::domain::ids::{SessionId, WorkspaceId};

type Res<T> = std::result::Result<T, String>;

#[tauri::command(async)]
pub fn workbench_view(
    state: tauri::State<'_, AppState>,
    workspace_id: WorkspaceId,
) -> Res<WorkbenchView> {
    state.engine.workbench_view(workspace_id).map_err(map_error)
}

#[tauri::command(async)]
pub fn workbench_join(state: tauri::State<'_, AppState>, session_id: SessionId) -> Res<()> {
    state.engine.workbench_join(session_id).map_err(map_error)
}

#[tauri::command(async)]
pub fn workbench_leave(state: tauri::State<'_, AppState>, session_id: SessionId) -> Res<()> {
    state.engine.workbench_leave(session_id).map_err(map_error)
}

/// The developer says something to every agent on the board, or to one. With a topic it is the
/// decision on that topic from then on.
#[tauri::command(async)]
pub fn workbench_direct(
    state: tauri::State<'_, AppState>,
    workspace_id: WorkspaceId,
    text: String,
    to: Option<SessionId>,
    topic: Option<String>,
) -> Res<WorkbenchEntry> {
    state
        .engine
        .workbench_direct(workspace_id, &text, to, topic.as_deref())
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn workbench_reply(
    state: tauri::State<'_, AppState>,
    entry_id: String,
    text: String,
) -> Res<WorkbenchEntry> {
    state
        .engine
        .workbench_reply(&entry_id, &text)
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn workbench_resolve(
    state: tauri::State<'_, AppState>,
    entry_id: String,
    resolution: Resolution,
) -> Res<()> {
    state
        .engine
        .workbench_resolve(&entry_id, resolution)
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn workbench_clear(state: tauri::State<'_, AppState>, workspace_id: WorkspaceId) -> Res<()> {
    state
        .engine
        .workbench_clear_board(workspace_id)
        .map_err(map_error)
}
