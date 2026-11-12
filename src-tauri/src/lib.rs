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
use tauri::{Manager, RunEvent};

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
            tauri_api::terminal_ensure,
            tauri_api::terminal_write,
            tauri_api::terminal_resize,
            tauri_api::terminal_kill,
            tauri_api::agent_list_providers,
            tauri_api::agent_start_session,
            tauri_api::agent_configure_session,
            tauri_api::agent_switch_provider,
            tauri_api::agent_get_options,
            tauri_api::agent_prompt,
            tauri_api::agent_cancel,
            tauri_api::agent_resolve_permission,
            tauri_api::agent_get_snapshot,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Concierge")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<tauri_api::AppState>() {
                    state.pty.shutdown_all();
                    state.agents.shutdown_all();
                }
            }
        });
}
