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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![tauri_api::core_status])
        .run(tauri::generate_context!())
        .expect("error while running Concierge");
}
