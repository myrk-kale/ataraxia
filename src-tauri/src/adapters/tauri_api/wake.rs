//! Commands for what the app keeps on while it has work in progress.

use super::{AppState, map_error};
use crate::adapters::sleep::WakeMode;

type Res<T> = std::result::Result<T, String>;

pub(super) const PREF_WAKE_MODE: &str = "wake.mode";

#[tauri::command]
pub fn wake_mode(state: tauri::State<'_, AppState>) -> WakeMode {
    state.sleep_guard.mode()
}

#[tauri::command]
pub fn wake_set_mode(state: tauri::State<'_, AppState>, mode: WakeMode) -> Res<WakeMode> {
    state
        .store
        .set_preference(PREF_WAKE_MODE, mode.as_str())
        .map_err(map_error)?;
    state.sleep_guard.set_mode(mode);
    Ok(mode)
}
