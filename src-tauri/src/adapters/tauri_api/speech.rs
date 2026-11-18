//! Commands for the microphone button in the message field: speech to text on this computer.

use base64::Engine as _;
use serde::Serialize;
use tauri::Emitter;

use super::{AppState, map_error};
use crate::adapters::speech::{
    self, Choice, Engine, LANGUAGES, MODEL_MEGABYTES, MODEL_URL, PREF_COMMAND, PREF_LANGUAGE,
};

type Res<T> = std::result::Result<T, String>;

#[derive(Debug, Serialize)]
pub struct SpeechLanguage {
    pub code: &'static str,
    pub name: &'static str,
}

/// What the settings and the button need to know about listening.
#[derive(Debug, Serialize)]
pub struct SpeechStatus {
    /// It can listen now.
    pub ready: bool,
    /// Which engine: the built-in one or the person's own command.
    pub engine: Option<String>,
    /// The built-in engine is chosen and its model has not been downloaded.
    pub needs_model: bool,
    pub downloading: bool,
    pub model_megabytes: u64,
    pub model_url: &'static str,
    /// Why it cannot listen, when it cannot for a reason other than the missing model.
    pub problem: Option<String>,
    /// What the person set, to show in the form.
    pub command: String,
    pub language: String,
    pub languages: Vec<SpeechLanguage>,
}

/// How far the model download has got.
#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgress {
    pub received: u64,
    pub total: Option<u64>,
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
        language: read(PREF_LANGUAGE),
    }
}

fn home() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
}

fn status_of(state: &AppState) -> SpeechStatus {
    let chosen = choice(state);
    let found = speech::detect(&chosen, home().as_deref());
    let needs_model = matches!(found, Ok(Engine::BuiltIn)) && !state.speech.model_ready();
    SpeechStatus {
        ready: found.is_ok() && !needs_model,
        engine: found.as_ref().ok().map(|engine| engine.name().to_string()),
        needs_model,
        downloading: state.speech.downloading(),
        model_megabytes: MODEL_MEGABYTES,
        model_url: MODEL_URL,
        problem: found.err().map(|error| error.message),
        command: chosen.command,
        language: chosen.language,
        languages: LANGUAGES
            .iter()
            .map(|(code, name)| SpeechLanguage { code, name })
            .collect(),
    }
}

#[tauri::command(async)]
pub fn speech_status(state: tauri::State<'_, AppState>) -> SpeechStatus {
    status_of(&state)
}

/// Saves the command (empty uses the built-in engine) and the language (empty detects it).
#[tauri::command(async)]
pub fn speech_set(
    state: tauri::State<'_, AppState>,
    command: String,
    language: String,
) -> Res<SpeechStatus> {
    let language = language.trim();
    if !LANGUAGES.iter().any(|(code, _)| *code == language) {
        return Err("error[invalid]: that language is not on the list".into());
    }
    state
        .store
        .set_preference(PREF_COMMAND, command.trim())
        .map_err(map_error)?;
    state
        .store
        .set_preference(PREF_LANGUAGE, language)
        .map_err(map_error)?;
    Ok(status_of(&state))
}

/// Downloads the speech model, telling the window how far it has got through `speech://download`.
#[tauri::command(async)]
pub fn speech_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Res<SpeechStatus> {
    state
        .speech
        .download(|received, total| {
            let _ = app.emit("speech://download", DownloadProgress { received, total });
        })
        .map_err(map_error)?;
    Ok(status_of(&state))
}

#[tauri::command]
pub fn speech_download_cancel(state: tauri::State<'_, AppState>) {
    state.speech.cancel_download();
}

/// Turns a recording (a 16 kHz mono WAV, base64) into text.
#[tauri::command(async)]
pub fn speech_transcribe(state: tauri::State<'_, AppState>, wav: String) -> Res<String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(wav.trim())
        .map_err(|_| "error[invalid]: the recording could not be read".to_string())?;
    let chosen = choice(&state);
    match speech::detect(&chosen, home().as_deref()).map_err(map_error)? {
        Engine::BuiltIn => state
            .speech
            .transcribe(&bytes, &chosen.language)
            .map_err(map_error),
        Engine::Custom { program, args } => {
            speech::transcribe_with_command(&program, &args, &bytes).map_err(map_error)
        }
    }
}
