//! Commands for the microphone button in the message field: speech to text on this computer.

use base64::Engine as _;
use serde::Serialize;

use super::{AppState, map_error};
use crate::adapters::speech::{self, Choice, MODEL_URL, PREF_COMMAND, PREF_MODEL};

type Res<T> = std::result::Result<T, String>;

/// What the settings and the button need to know about listening.
#[derive(Debug, Serialize)]
pub struct SpeechStatus {
    /// An engine was found and can listen.
    pub ready: bool,
    /// Which one, when found.
    pub engine: Option<String>,
    /// Why there is none, or how to fix it, when there is not.
    pub problem: Option<String>,
    /// What the person set, to show in the form.
    pub command: String,
    pub model: String,
    pub model_url: &'static str,
}

fn choice(state: &AppState) -> Choice {
    let read = |key: &str| {
        state
            .store
            .get_preference(key)
            .ok()
            .flatten()
            .unwrap_or_default()
    };
    Choice {
        command: read(PREF_COMMAND),
        model: read(PREF_MODEL),
    }
}

fn home() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
}

#[tauri::command(async)]
pub fn speech_status(state: tauri::State<'_, AppState>) -> SpeechStatus {
    let chosen = choice(&state);
    let found = speech::detect(&chosen, home().as_deref());
    SpeechStatus {
        ready: found.is_ok(),
        engine: found.as_ref().ok().map(|engine| engine.name().to_string()),
        problem: found.err().map(|error| error.message),
        command: chosen.command,
        model: chosen.model,
        model_url: MODEL_URL,
    }
}

/// Saves the command and model file the person chose (empty means "find one") and answers with
/// what that makes of listening.
#[tauri::command(async)]
pub fn speech_set(
    state: tauri::State<'_, AppState>,
    command: String,
    model: String,
) -> Res<SpeechStatus> {
    state
        .store
        .set_preference(PREF_COMMAND, command.trim())
        .map_err(map_error)?;
    state
        .store
        .set_preference(PREF_MODEL, model.trim())
        .map_err(map_error)?;
    Ok(speech_status(state))
}

/// Turns a recording (a WAV file, base64) into text.
#[tauri::command(async)]
pub fn speech_transcribe(state: tauri::State<'_, AppState>, wav: String) -> Res<String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(wav.trim())
        .map_err(|_| "error[invalid]: the recording could not be read".to_string())?;
    let engine = speech::detect(&choice(&state), home().as_deref()).map_err(map_error)?;
    speech::transcribe(&engine, &bytes).map_err(map_error)
}
