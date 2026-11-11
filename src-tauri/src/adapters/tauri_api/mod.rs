//! Tauri commands: the driving adapter at the UI edge.

use crate::app;

#[tauri::command]
pub fn core_status() -> String {
    app::core_status_message()
}
