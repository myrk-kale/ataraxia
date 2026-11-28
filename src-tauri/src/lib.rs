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
pub mod files;
pub mod ports;

use adapters::tauri_api;
use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(tauri_api::PendingUpdate::default())
        .setup(|app| {
            let state = tauri_api::build_app_state(app.handle())
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            app.manage(state);
            app.manage(adapters::lsp::LspManager::new(app.handle().clone()));
            tauri_api::follow_git(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            tauri_api::core_status,
            tauri_api::workspace_bootstrap,
            tauri_api::workspace_open_repository,
            tauri_api::workspace_register_repository,
            tauri_api::global_search,
            tauri_api::workspace_select_workspace,
            tauri_api::workspace_previous_workspace,
            tauri_api::workspace_create_workspace,
            tauri_api::workspace_update_workspace,
            tauri_api::workspace_delete_workspace,
            tauri_api::workspace_select_repository,
            tauri_api::workspace_select_worktree,
            tauri_api::workspace_list_branches,
            tauri_api::workspace_select_branch,
            tauri_api::workspace_go_to_branch,
            tauri_api::workspace_fetch_branches,
            tauri_api::workspace_checkout_remote_branch,
            tauri_api::workspace_create_branch,
            tauri_api::workspace_create_session,
            tauri_api::workspace_open_session,
            tauri_api::workspace_delete_session,
            tauri_api::terminal_ensure,
            tauri_api::terminal_write,
            tauri_api::terminal_resize,
            tauri_api::terminal_kill,
            tauri_api::agent_list_providers,
            tauri_api::agent_list_mcp_processes,
            tauri_api::agent_stop_mcp_process,
            tauri_api::agent_repository_mcp_approval,
            tauri_api::agent_trust_repository_mcp,
            tauri_api::agent_start_session,
            tauri_api::agent_configure_session,
            tauri_api::agent_switch_provider,
            tauri_api::agent_get_options,
            tauri_api::agent_list_composer_resources,
            tauri_api::agent_message_subagent,
            tauri_api::agent_prompt,
            tauri_api::agent_attachment,
            tauri_api::agent_queue,
            tauri_api::browser_state,
            tauri_api::browser_history,
            tauri_api::browser_clear_history,
            tauri_api::browser_open,
            tauri_api::browser_close,
            tauri_api::browser_activate,
            tauri_api::browser_navigate,
            tauri_api::browser_go,
            tauri_api::browser_stop,
            tauri_api::browser_set_bounds,
            tauri_api::browser_set_visible,
            tauri_api::browser_set_agent_control,
            tauri_api::browser_set_agents_allowed,
            tauri_api::browser_logs,
            tauri_api::browser_clear_logs,
            tauri_api::browser_request_as,
            tauri_api::browser_count_requests,
            tauri_api::browser_devtools,
            tauri_api::browser_screenshot,
            tauri_api::browser_clear_data,
            tauri_api::agent_usage,
            tauri_api::profiles_list,
            tauri_api::profile_save,
            tauri_api::profile_delete,
            tauri_api::agent_set_profile,
            tauri_api::profile_check,
            tauri_api::agent_enqueue,
            tauri_api::agent_queue_remove,
            tauri_api::agent_queue_set_paused,
            tauri_api::schedule_list,
            tauri_api::schedule_cancel,
            tauri_api::agent_queue_send_now,
            tauri_api::agent_cancel,
            tauri_api::agent_resolve_permission,
            tauri_api::agent_get_snapshot,
            tauri_api::agent_cancel_rate_wait,
            tauri_api::session_get,
            tauri_api::code_tree,
            tauri_api::code_change_file,
            tauri_api::session_paths,
            tauri_api::session_chats,
            tauri_api::code_read,
            tauri_api::code_definitions,
            tauri_api::code_lint_status,
            tauri_api::code_lint_trust,
            tauri_api::code_lint_file,
            tauri_api::resources_list,
            tauri_api::resources_set_state,
            tauri_api::resources_read_skill,
            tauri_api::resources_save_skill,
            tauri_api::resources_delete_skill,
            tauri_api::resources_read_mcp,
            tauri_api::resources_sign_in_mcp,
            tauri_api::resources_save_mcp,
            tauri_api::resources_delete_mcp,
            tauri_api::lsp_sync,
            tauri_api::lsp_saved,
            tauri_api::lsp_close,
            tauri_api::lsp_complete,
            tauri_api::lsp_definition,
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
            tauri_api::review_triage,
            tauri_api::review_triage_cancel,
            tauri_api::review_untriage,
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
            tauri_api::btw_session,
            tauri_api::btw_allow_edits,
            tauri_api::flow_presets,
            tauri_api::flow_save_preset,
            tauri_api::flow_delete_preset,
            tauri_api::flow_generate,
            tauri_api::flow_list,
            tauri_api::code_refs,
            tauri_api::code_compare,
            tauri_api::autocomplete_suggest,
            tauri_api::autocomplete_settings,
            tauri_api::autocomplete_set_settings,
            tauri_api::autocomplete_languages,
            tauri_api::autocomplete_forget,
            tauri_api::speech_status,
            tauri_api::wake_mode,
            tauri_api::wake_set_mode,
            tauri_api::speech_set,
            tauri_api::speech_download,
            tauri_api::speech_download_cancel,
            tauri_api::speech_transcribe,
            tauri_api::speech_warmup,
            tauri_api::tasks_list,
            tauri_api::task_create,
            tauri_api::task_update,
            tauri_api::task_delete,
            tauri_api::memory_snapshot,
            tauri_api::memory_set_enabled,
            tauri_api::memory_create,
            tauri_api::memory_update,
            tauri_api::memory_delete,
            tauri_api::memory_link,
            tauri_api::memory_unlink,
            tauri_api::workbench_view,
            tauri_api::workbench_join,
            tauri_api::workbench_leave,
            tauri_api::workbench_direct,
            tauri_api::workbench_reply,
            tauri_api::workbench_resolve,
            tauri_api::workbench_clear,
            tauri_api::update_check,
            tauri_api::update_install,
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
