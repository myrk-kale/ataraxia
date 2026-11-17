//! Commands of the editor's language servers. Every one of them starts or reaches a program the
//! repository chose, so they answer nothing until the user trusted the repository.

use std::path::PathBuf;

use super::{AppState, map_error};
use crate::adapters::lsp::{Completions, LspManager, Place};
use crate::app::lint::safe_relative;
use crate::domain::ids::WorktreeId;

type Res<T> = std::result::Result<T, String>;

/// The worktree folder when the repository is trusted and the path is inside it.
fn trusted(state: &AppState, worktree_id: WorktreeId, path: &str) -> Option<PathBuf> {
    safe_relative(path).ok()?;
    state.engine.lint_trusted_root(worktree_id).ok()
}

/// Opens or updates a document on its language server. The name of the server, or `None` when
/// the file has none.
#[tauri::command(async)]
pub fn lsp_sync(
    state: tauri::State<'_, AppState>,
    lsp: tauri::State<'_, LspManager>,
    worktree_id: WorktreeId,
    path: String,
    text: String,
) -> Res<Option<String>> {
    let Some(root) = trusted(&state, worktree_id, &path) else {
        return Ok(None);
    };
    Ok(lsp.sync(&worktree_id.0.to_string(), &root, &path, &text))
}

#[tauri::command(async)]
pub fn lsp_saved(
    state: tauri::State<'_, AppState>,
    lsp: tauri::State<'_, LspManager>,
    worktree_id: WorktreeId,
    path: String,
) -> Res<()> {
    if let Some(root) = trusted(&state, worktree_id, &path) {
        lsp.saved(&worktree_id.0.to_string(), &root, &path);
    }
    Ok(())
}

#[tauri::command(async)]
pub fn lsp_close(
    state: tauri::State<'_, AppState>,
    lsp: tauri::State<'_, LspManager>,
    worktree_id: WorktreeId,
    path: String,
) -> Res<()> {
    if let Some(root) = trusted(&state, worktree_id, &path) {
        lsp.close(&worktree_id.0.to_string(), &root, &path);
    }
    Ok(())
}

/// Completions at a position (zero-based line and UTF-16 character, as LSP counts).
#[tauri::command(async)]
pub fn lsp_complete(
    state: tauri::State<'_, AppState>,
    lsp: tauri::State<'_, LspManager>,
    worktree_id: WorktreeId,
    path: String,
    line: u32,
    character: u32,
    trigger: Option<String>,
) -> Res<Completions> {
    let Some(root) = trusted(&state, worktree_id, &path) else {
        return Ok(Completions {
            items: Vec::new(),
            incomplete: false,
        });
    };
    lsp.complete(
        &worktree_id.0.to_string(),
        &root,
        &path,
        line,
        character,
        trigger.as_deref(),
    )
    .map_err(map_error)
}

#[tauri::command(async)]
pub fn lsp_definition(
    state: tauri::State<'_, AppState>,
    lsp: tauri::State<'_, LspManager>,
    worktree_id: WorktreeId,
    path: String,
    line: u32,
    character: u32,
) -> Res<Vec<Place>> {
    let Some(root) = trusted(&state, worktree_id, &path) else {
        return Ok(Vec::new());
    };
    lsp.definition(&worktree_id.0.to_string(), &root, &path, line, character)
        .map_err(map_error)
}
