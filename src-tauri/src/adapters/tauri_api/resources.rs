//! The skills and MCP servers manager: what exists in each scope, what is switched on, and the
//! files that define them. Changes reach an agent the next time its session starts.

use std::sync::Arc;

use serde_json::Value;

use super::{AppState, map_error};
use crate::adapters::agents::resources::{Context, Kind, ResourceList, ResourceManager, SkillText};

type Res<T> = std::result::Result<T, String>;

fn manager(state: &AppState) -> Res<ResourceManager> {
    let data_dir = state
        .db_path
        .parent()
        .ok_or_else(|| "error[io]: the app has no data folder".to_string())?
        .to_path_buf();
    Ok(ResourceManager::new(Arc::clone(&state.store), data_dir))
}

#[tauri::command(async)]
pub fn resources_list(state: tauri::State<'_, AppState>, context: Context) -> Res<ResourceList> {
    manager(&state)?.list(context).map_err(map_error)
}

#[tauri::command(async)]
pub fn resources_set_state(
    state: tauri::State<'_, AppState>,
    context: Context,
    kind: Kind,
    id: String,
    mark: String,
) -> Res<()> {
    manager(&state)?
        .set_state(context, kind, &id, &mark)
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn resources_read_skill(
    state: tauri::State<'_, AppState>,
    context: Context,
    id: String,
) -> Res<SkillText> {
    manager(&state)?.read_skill(context, &id).map_err(map_error)
}

#[tauri::command(async)]
pub fn resources_save_skill(
    state: tauri::State<'_, AppState>,
    context: Context,
    id: String,
    description: String,
    body: String,
    replace: bool,
) -> Res<()> {
    manager(&state)?
        .save_skill(context, &id, &description, &body, replace)
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn resources_delete_skill(
    state: tauri::State<'_, AppState>,
    context: Context,
    id: String,
) -> Res<()> {
    manager(&state)?
        .delete_skill(context, &id)
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn resources_read_mcp(
    state: tauri::State<'_, AppState>,
    context: Context,
    name: String,
) -> Res<Value> {
    manager(&state)?.read_mcp(context, &name).map_err(map_error)
}

#[tauri::command(async)]
pub fn resources_save_mcp(
    state: tauri::State<'_, AppState>,
    context: Context,
    name: String,
    config: Value,
    replace: bool,
) -> Res<()> {
    manager(&state)?
        .save_mcp(context, &name, config, replace)
        .map_err(map_error)
}

#[tauri::command(async)]
pub fn resources_delete_mcp(
    state: tauri::State<'_, AppState>,
    context: Context,
    name: String,
) -> Res<()> {
    manager(&state)?
        .delete_mcp(context, &name)
        .map_err(map_error)
}
