//! Commands for the microphone button in the message field: speech to text on this computer.

use base64::Engine as _;
use serde::Serialize;
use tauri::Emitter;

use super::{AppState, map_error};
use crate::adapters::speech::{
    self, Choice, Engine, LANGUAGES, MODELS, Model, PREF_COMMAND, PREF_LANGUAGE, PREF_MODEL,
};

type Res<T> = std::result::Result<T, String>;

#[derive(Debug, Serialize)]
pub struct SpeechLanguage {
    pub code: &'static str,
    pub name: &'static str,
}

/// A model the built-in engine can listen with.
#[derive(Debug, Serialize)]
pub struct SpeechModel {
    pub id: &'static str,
    pub name: &'static str,
    pub megabytes: u64,
    pub downloaded: bool,
}

/// What the settings and the button need to know about listening.
#[derive(Debug, Serialize)]
pub struct SpeechStatus {
    /// It can listen now.
    pub ready: bool,
    /// Which engine: the built-in one or the person's own command.
    pub engine: Option<String>,
    /// The engine can write the text while the person is still speaking: the built-in one can, a
    /// command of the person's own is started once per recording and cannot.
    pub streaming: bool,
    /// The built-in engine is chosen and its model has not been downloaded.
    pub needs_model: bool,
    pub downloading: bool,
    /// The model in use, and what it weighs.
    pub model: &'static str,
    pub model_megabytes: u64,
    pub model_url: &'static str,
    pub models: Vec<SpeechModel>,
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

/// The model to listen with: what the person chose, or what is already on disk.
fn model_of(state: &AppState) -> &'static Model {
    let saved = state
        .store
        .get_preference(PREF_MODEL)
        .ok()
        .flatten()
        .unwrap_or_default();
    speech::model_named(&saved)
}

fn status_of(state: &AppState) -> SpeechStatus {
    let chosen = choice(state);
    let model = model_of(state);
    let found = speech::detect(&chosen, home().as_deref());
    let built_in = matches!(found, Ok(Engine::BuiltIn));
    let needs_model = built_in && !state.speech.model_ready(model);
    SpeechStatus {
        ready: found.is_ok() && !needs_model,
        engine: found.as_ref().ok().map(|engine| engine.name().to_string()),
        streaming: built_in,
        needs_model,
        downloading: state.speech.downloading(),
        model: model.id,
        model_megabytes: model.megabytes,
        model_url: model.url,
        models: MODELS
            .iter()
            .map(|item| SpeechModel {
                id: item.id,
                name: item.name,
                megabytes: item.megabytes,
                downloaded: state.speech.model_ready(item),
            })
            .collect(),
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

/// Saves the command (empty uses the built-in engine), the language (empty detects it) and, when
/// given, the model to listen with.
#[tauri::command(async)]
pub fn speech_set(
    state: tauri::State<'_, AppState>,
    command: String,
    language: String,
    model: Option<String>,
) -> Res<SpeechStatus> {
    let language = language.trim();
    if !LANGUAGES.iter().any(|(code, _)| *code == language) {
        return Err("error[invalid]: that language is not on the list".into());
    }
    if let Some(model) = model.as_deref() {
        if !MODELS.iter().any(|item| item.id == model) {
            return Err("error[invalid]: that speech model is not on the list".into());
        }
        state
            .store
            .set_preference(PREF_MODEL, model)
            .map_err(map_error)?;
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

/// Downloads the model in use, telling the window how far it has got through `speech://download`.
#[tauri::command(async)]
pub fn speech_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Res<SpeechStatus> {
    state
        .speech
        .download(model_of(&state), |received, total| {
            let _ = app.emit("speech://download", DownloadProgress { received, total });
        })
        .map_err(map_error)?;
    Ok(status_of(&state))
}

#[tauri::command]
pub fn speech_download_cancel(state: tauri::State<'_, AppState>) {
    state.speech.cancel_download();
}

/// Loads the model ahead of the first words, so that listening does not begin with a wait. It does
/// nothing when a command of the person's own is in use, or the model is not there yet.
#[tauri::command(async)]
pub fn speech_warmup(state: tauri::State<'_, AppState>) {
    let model = model_of(&state);
    if matches!(
        speech::detect(&choice(&state), home().as_deref()),
        Ok(Engine::BuiltIn)
    ) && state.speech.model_ready(model)
    {
        let _ = state.speech.warm_up(model);
    }
}

/// Turns a recording (a 16 kHz mono WAV, base64) into text. `quick` asks for a preview of what is
/// still being said: sooner, and less careful, than the text that is kept.
#[tauri::command(async)]
pub fn speech_transcribe(
    state: tauri::State<'_, AppState>,
    wav: String,
    quick: Option<bool>,
) -> Res<String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(wav.trim())
        .map_err(|_| "error[invalid]: the recording could not be read".to_string())?;
    let chosen = choice(&state);
    match speech::detect(&chosen, home().as_deref()).map_err(map_error)? {
        Engine::BuiltIn => state
            .speech
            .transcribe(
                model_of(&state),
                &bytes,
                &chosen.language,
                quick.unwrap_or(false),
            )
            .map_err(map_error),
        Engine::Custom { program, args } => {
            speech::transcribe_with_command(&program, &args, &bytes).map_err(map_error)
        }
    }
}
