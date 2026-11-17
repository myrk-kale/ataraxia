//! Commands for the message field's autocomplete and its settings.

use super::{AppState, map_error};
use crate::app::autocomplete::{AutocompleteLanguage, AutocompleteSettings, Suggestion, languages};
use crate::domain::ids::SessionId;

type Res<T> = std::result::Result<T, String>;

/// What to add after `text` (which ends at the caret), if anything.
#[tauri::command(async)]
pub fn autocomplete_suggest(
    state: tauri::State<'_, AppState>,
    session_id: SessionId,
    text: String,
) -> Option<Suggestion> {
    state.engine.autocomplete_suggest(session_id, &text)
}

/// The settings; `locale` (the system's, as the window knows it) picks the languages the first time.
#[tauri::command]
pub fn autocomplete_settings(
    state: tauri::State<'_, AppState>,
    locale: Option<String>,
) -> AutocompleteSettings {
    state.engine.autocomplete_settings(locale.as_deref())
}

#[tauri::command]
pub fn autocomplete_set_settings(
    state: tauri::State<'_, AppState>,
    settings: AutocompleteSettings,
) -> Res<AutocompleteSettings> {
    state
        .engine
        .autocomplete_set_settings(settings)
        .map_err(map_error)
}

#[tauri::command]
pub fn autocomplete_languages() -> Vec<AutocompleteLanguage> {
    languages()
}

/// Forgets everything the autocomplete learned.
#[tauri::command]
pub fn autocomplete_forget(state: tauri::State<'_, AppState>) -> Res<()> {
    state.engine.autocomplete_forget().map_err(map_error)
}

/// Learns from a message the person sent, without holding the send up.
pub(super) fn learn(state: &AppState, session_id: SessionId, text: &str) {
    let engine = std::sync::Arc::clone(&state.engine);
    let text = text.to_string();
    std::thread::spawn(move || engine.autocomplete_learn(session_id, &text));
}
