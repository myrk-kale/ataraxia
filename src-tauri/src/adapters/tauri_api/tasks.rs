//! Commands for the developer's task list.

use super::{AppState, map_error};
use crate::app::tasks;
use crate::domain::{Task, TaskPatch};

type Res<T> = std::result::Result<T, String>;

#[tauri::command]
pub fn tasks_list(state: tauri::State<'_, AppState>) -> Res<Vec<Task>> {
    tasks::list(state.store.as_ref()).map_err(map_error)
}

#[tauri::command]
pub fn task_create(state: tauri::State<'_, AppState>, title: String) -> Res<Task> {
    tasks::create(state.store.as_ref(), &title).map_err(map_error)
}

#[tauri::command]
pub fn task_update(state: tauri::State<'_, AppState>, number: i64, patch: TaskPatch) -> Res<Task> {
    tasks::update(state.store.as_ref(), number, patch).map_err(map_error)
}

#[tauri::command]
pub fn task_delete(state: tauri::State<'_, AppState>, number: i64) -> Res<()> {
    tasks::delete(state.store.as_ref(), number).map_err(map_error)
}
