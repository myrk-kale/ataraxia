//! Commands for the memory screens: Settings and the graph. They act as the developer, who sees
//! every memory, global and of every workspace.

use serde::{Deserialize, Deserializer, Serialize};

use super::{AppState, map_error};
use crate::app::memory::{self, NewMemory, Patch, Viewer};
use crate::domain::ids::WorkspaceId;
use crate::domain::{Memory, MemoryKind, MemoryLink, MemorySource, Relation};

type Res<T> = std::result::Result<T, String>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySnapshot {
    pub enabled: bool,
    pub memories: Vec<Memory>,
    pub links: Vec<MemoryLink>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInput {
    pub kind: MemoryKind,
    /// `None` is the developer's global memory.
    pub workspace_id: Option<WorkspaceId>,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub expires_at: Option<String>,
}

/// Tells "not given" from "given as null": a patch that names `workspaceId: null` moves the
/// memory to the global scope, and one that leaves it out leaves it where it is.
fn given<'de, D, T>(deserializer: D) -> std::result::Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryChange {
    pub kind: Option<MemoryKind>,
    #[serde(default, deserialize_with = "given")]
    pub workspace_id: Option<Option<WorkspaceId>>,
    pub title: Option<String>,
    pub body: Option<String>,
    pub tags: Option<Vec<String>>,
    pub source: Option<MemorySource>,
    #[serde(default, deserialize_with = "given")]
    pub expires_at: Option<Option<String>>,
}

#[tauri::command]
pub fn memory_snapshot(state: tauri::State<'_, AppState>) -> Res<MemorySnapshot> {
    let store = state.store.as_ref();
    let graph = memory::graph(store, Viewer::developer()).map_err(map_error)?;
    Ok(MemorySnapshot {
        enabled: memory::enabled(store),
        memories: graph.memories,
        links: graph.links,
    })
}

#[tauri::command]
pub fn memory_set_enabled(state: tauri::State<'_, AppState>, enabled: bool) -> Res<()> {
    memory::set_enabled(state.store.as_ref(), enabled).map_err(map_error)
}

#[tauri::command]
pub fn memory_create(state: tauri::State<'_, AppState>, input: MemoryInput) -> Res<Memory> {
    memory::create(
        state.store.as_ref(),
        Viewer::developer(),
        NewMemory {
            kind: input.kind,
            workspace_id: input.workspace_id,
            title: input.title,
            body: input.body,
            tags: input.tags,
            // Written by the developer, so it is their word.
            source: MemorySource::User,
            expires_at: input.expires_at,
            links: Vec::new(),
        },
    )
    .map(|created| created.memory)
    .map_err(map_error)
}

#[tauri::command]
pub fn memory_update(
    state: tauri::State<'_, AppState>,
    id: String,
    change: MemoryChange,
) -> Res<Memory> {
    memory::update(
        state.store.as_ref(),
        Viewer::developer(),
        &id,
        Patch {
            kind: change.kind,
            workspace_id: change.workspace_id,
            title: change.title,
            body: change.body,
            tags: change.tags,
            source: change.source,
            expires_at: change.expires_at,
        },
    )
    .map_err(map_error)
}

#[tauri::command]
pub fn memory_delete(state: tauri::State<'_, AppState>, id: String) -> Res<()> {
    memory::delete(state.store.as_ref(), Viewer::developer(), &id).map_err(map_error)
}

#[tauri::command]
pub fn memory_link(
    state: tauri::State<'_, AppState>,
    from: String,
    to: String,
    relation: Relation,
) -> Res<MemoryLink> {
    memory::link(
        state.store.as_ref(),
        Viewer::developer(),
        &from,
        &to,
        relation,
    )
    .map_err(map_error)
}

#[tauri::command]
pub fn memory_unlink(
    state: tauri::State<'_, AppState>,
    from: String,
    to: String,
    relation: Relation,
) -> Res<()> {
    memory::unlink(
        state.store.as_ref(),
        Viewer::developer(),
        &from,
        &to,
        relation,
    )
    .map_err(map_error)
}
