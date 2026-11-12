//! Concierge core: hexagonal single crate.
//!
//! Layout:
//! - [`domain`]: pure types and invariants
//! - [`ports`]: side-effect traits
//! - [`app`]: use-cases over ports
//! - [`adapters`]: git/fs/sqlite/pty/agents/tauri edge

pub mod adapters;
pub mod app;
pub mod domain;
pub mod ports;

use adapters::tauri_api;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let state = tauri_api::build_app_state(app.handle())
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            tauri_api::core_status,
            tauri_api::workspace_bootstrap,
            tauri_api::workspace_open_repository,
            tauri_api::workspace_select_repository,
            tauri_api::workspace_select_worktree,
            tauri_api::workspace_create_session,
            tauri_api::workspace_open_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Concierge");
}
