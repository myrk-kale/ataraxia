//! Ataraxia core: hexagonal single crate.
//!
//! Layout:
//! - [`domain`]: pure types and invariants
//! - [`ports`]: side-effect traits
//! - [`app`]: use-cases over ports
//! - [`adapters`]: git/fs/sqlite/pty/agents/tauri edge

pub mod adapters;
pub mod api;
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
            tauri_api::follow_git(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            tauri_api::core_status,
            tauri_api::workspace_bootstrap,
            tauri_api::workspace_open_repository,
            tauri_api::workspace_register_repository,
            tauri_api::workspace_select_workspace,
            tauri_api::workspace_create_workspace,
            tauri_api::workspace_update_workspace,
            tauri_api::workspace_delete_workspace,
            tauri_api::workspace_select_repository,
            tauri_api::workspace_select_worktree,
            tauri_api::workspace_list_branches,
            tauri_api::workspace_select_branch,
            tauri_api::workspace_create_session,
            tauri_api::workspace_open_session,
            tauri_api::workspace_delete_session,
            tauri_api::terminal_ensure,
            tauri_api::terminal_write,
            tauri_api::terminal_resize,
            tauri_api::terminal_kill,
            tauri_api::agent_list_providers,
            tauri_api::agent_start_session,
            tauri_api::agent_configure_session,
            tauri_api::agent_switch_provider,
            tauri_api::agent_get_options,
            tauri_api::agent_message_subagent,
            tauri_api::agent_prompt,
            tauri_api::agent_attachment,
            tauri_api::agent_queue,
            tauri_api::agent_usage,
            tauri_api::profiles_list,
            tauri_api::profile_save,
            tauri_api::profile_delete,
            tauri_api::profile_set_active,
            tauri_api::profile_check,
            tauri_api::agent_enqueue,
            tauri_api::agent_queue_remove,
            tauri_api::agent_queue_send_now,
            tauri_api::agent_cancel,
            tauri_api::agent_resolve_permission,
            tauri_api::agent_get_snapshot,
            tauri_api::session_get,
            tauri_api::code_tree,
            tauri_api::code_read,
            tauri_api::code_write,
            tauri_api::code_file_at,
            tauri_api::code_review,
            tauri_api::code_refresh_checkpoint,
            tauri_api::code_repo_changes,
            tauri_api::code_set_review_mark,
            tauri_api::code_add_comment,
            tauri_api::artifacts_list,
            tauri_api::artifact_retry,
            tauri_api::checkpoints_list,
            tauri_api::decisions_generate,
            tauri_api::review_reset_priority,
            tauri_api::artifacts_delete_all,
            tauri_api::decision_create,
            tauri_api::decision_link_commit,
            tauri_api::decision_unlink_commit,
            tauri_api::decision_commit_candidates,
            tauri_api::decisions_list,
            tauri_api::decision_detail,
            tauri_api::decision_set_state,
            tauri_api::decision_comment,
            tauri_api::decision_post_message,
            tauri_api::decision_request_change,
            tauri_api::btw_preview_context,
            tauri_api::btw_start,
            tauri_api::btw_list,
            tauri_api::btw_return,
            tauri_api::btw_session,
            tauri_api::flow_presets,
            tauri_api::flow_save_preset,
            tauri_api::flow_delete_preset,
            tauri_api::flow_generate,
            tauri_api::flow_list,
            tauri_api::code_refs,
            tauri_api::code_compare,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Ataraxia")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<tauri_api::AppState>() {
                    state.pty.shutdown_all();
                    state.agents.shutdown_all();
                }
            }
        });
}
