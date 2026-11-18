//! Speech to text, on this computer: what the person says into the message field becomes text with
//! Whisper (the `large-v3-turbo` model), which is built into the app (whisper.cpp). Nothing is
//! sent anywhere to be understood: the recording is read from memory, and the only download is the
//! model itself, once, when the person agrees to it.
//!
//! A command of the person's own (`{file}` stands for the recording; it prints the text) takes
//! the place of the built-in engine when one is set.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::adapters::agents::process::{enriched_path, resolve_program};
use crate::domain::{Error, ErrorCode, Result, parse_command};

/// Preference keys under which the person's choices are kept.
pub const PREF_COMMAND: &str = "speech.command";
pub const PREF_LANGUAGE: &str = "speech.language";

/// A recording longer than this is refused: a message, not a lecture.
const MAX_WAV_BYTES: usize = 40 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(180);
/// A model kept in memory is let go of after this long without use.
const KEEP_LOADED: Duration = Duration::from_secs(300);

/// The model: Whisper large-v3-turbo, quantised to 5 bits so it is a bit over half a gigabyte.
pub const MODEL_FILE: &str = "ggml-large-v3-turbo-q5_0.bin";
pub const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin";
/// What the download says it weighs, for the person to read before agreeing.
pub const MODEL_MEGABYTES: u64 = 574;
/// Anything smaller than this is not the model (a failed download, an error page).
const MIN_MODEL_BYTES: u64 = 400 * 1024 * 1024;

/// The languages the person can pin Whisper to; empty is "work it out".
pub const LANGUAGES: &[(&str, &str)] = &[
    ("", "Detect it"),
    ("en", "English"),
    ("pt", "Português"),
    ("es", "Español"),
    ("fr", "Français"),
    ("de", "Deutsch"),
    ("it", "Italiano"),
    ("nl", "Nederlands"),
    ("ja", "日本語"),
    ("zh", "中文"),
    ("ko", "한국어"),
    ("ru", "Русский"),
];

/// What the person set; empty means the built-in engine, with the language detected.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Choice {
    pub command: String,
    pub language: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Engine {
    /// A command the person wrote; `{file}` is replaced by the recording.
    Custom { program: PathBuf, args: Vec<String> },
    /// Whisper inside the app; it needs the model downloaded.
    BuiltIn,
}

impl Engine {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Custom { .. } => "your command",
            Self::BuiltIn => "built-in Whisper",
        }
    }
}

/// Chooses the engine. The built-in one is the answer unless a command was set.
pub fn detect(choice: &Choice, home: Option<&Path>) -> Result<Engine> {
    let command = choice.command.trim();
    if command.is_empty() {
        return Ok(Engine::BuiltIn);
    }
    let parsed = parse_command(command, home)?;
    let name = parsed
        .program
        .clone()
        .ok_or_else(|| Error::new(ErrorCode::Invalid, "the speech command needs a program"))?;
    let program = resolve_program(&name).ok_or_else(|| {
        Error::new(
            ErrorCode::NotFound,
            format!("the speech command `{name}` was not found"),
        )
    })?;
    Ok(Engine::Custom {
        program,
        args: parsed.args,
    })
}

/// What the engine printed, without the markers Whisper adds: timestamps, silence and music tags.
pub fn clean_transcript(raw: &str) -> String {
    let mut lines = Vec::new();
    for line in raw.lines() {
        let mut line = line.trim();
        // `[00:00:00.000 --> 00:00:04.000]  text`
        if line.starts_with('[') {
            if let Some((stamp, rest)) = line.split_once(']') {
                if stamp.contains("-->") {
                    line = rest.trim();
                }
            }
        }
        let tag = line.trim_matches(|c| c == '[' || c == ']' || c == '(' || c == ')' || c == '*');
        let upper = tag.to_uppercase();
        let marker = (line.starts_with('[') && line.ends_with(']'))
            || (line.starts_with('(') && line.ends_with(')'));
        if line.is_empty()
            || (marker
                && [
                    "BLANK_AUDIO",
                    "SILENCE",
                    "MUSIC",
                    "NOISE",
                    "APPLAUSE",
                    "INAUDIBLE",
                ]
                .iter()
                .any(|word| upper.contains(word)))
        {
            continue;
        }
        lines.push(line.to_string());
    }
    lines
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// A WAV file (RIFF, WAVE) of a sensible size; the recorder in the window makes these.
pub fn check_wav(bytes: &[u8]) -> Result<()> {
    if bytes.len() < 64 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(Error::new(
            ErrorCode::Invalid,
            "the recording is not a WAV file",
        ));
    }
    if bytes.len() > MAX_WAV_BYTES {
        return Err(Error::new(
            ErrorCode::Invalid,
            "the recording is too long: say it in pieces",
        ));
    }
    Ok(())
}

/// The 16-bit mono samples of a WAV file, as the floats Whisper wants.
pub fn wav_samples(bytes: &[u8]) -> Result<Vec<f32>> {
    check_wav(bytes)?;
    let invalid = |what: &str| Error::new(ErrorCode::Invalid, format!("the recording {what}"));
    let mut at = 12;
    let mut format: Option<(u16, u16, u32, u16)> = None;
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let size = u32::from_le_bytes([bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]])
            as usize;
        let body = at + 8;
        if id == b"fmt " && body + 16 <= bytes.len() {
            let word = |i: usize| u16::from_le_bytes([bytes[body + i], bytes[body + i + 1]]);
            let rate = u32::from_le_bytes([
                bytes[body + 4],
                bytes[body + 5],
                bytes[body + 6],
                bytes[body + 7],
            ]);
            format = Some((word(0), word(2), rate, word(14)));
        } else if id == b"data" {
            let (tag, channels, rate, bits) = format.ok_or_else(|| invalid("has no format"))?;
            if tag != 1 || channels != 1 || bits != 16 || rate != 16000 {
                return Err(invalid("must be 16 kHz mono 16-bit"));
            }
            let end = (body + size).min(bytes.len());
            return Ok(bytes[body..end]
                .chunks_exact(2)
                .map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as f32 / 32768.0)
                .collect());
        }
        at = body + size + (size & 1);
    }
    Err(invalid("has no audio"))
}

fn drain(mut source: impl Read + Send + 'static) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = source.read_to_end(&mut bytes);
        String::from_utf8_lossy(&bytes).into_owned()
    })
}

/// Runs the person's own command on the recording and takes what it prints. The recording lives in
/// a private temporary folder for as long as the command needs it.
pub fn transcribe_with_command(program: &Path, args: &[String], wav: &[u8]) -> Result<String> {
    check_wav(wav)?;
    let dir = tempfile::Builder::new()
        .prefix("ataraxia-speech-")
        .tempdir()
        .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
    let file = dir.path().join("recording.wav");
    std::fs::write(&file, wav).map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
    let name = file.to_string_lossy().into_owned();
    let mut args: Vec<String> = args
        .iter()
        .map(|arg| arg.replace("{file}", &name))
        .collect();
    if !args.iter().any(|arg| arg.contains(&name)) {
        args.push(name);
    }
    let mut child = Command::new(program)
        .args(&args)
        .current_dir(dir.path())
        .env("PATH", enriched_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            Error::new(
                ErrorCode::Io,
                format!("could not start {}: {error}", program.display()),
            )
        })?;
    let stdout = drain(child.stdout.take().expect("piped"));
    let stderr = drain(child.stderr.take().expect("piped"));
    let deadline = Instant::now() + TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Error::new(
                    ErrorCode::Io,
                    "your speech command took too long to listen",
                ));
            }
            Err(error) => return Err(Error::new(ErrorCode::Io, error.to_string())),
        }
    };
    let printed = stdout.join().unwrap_or_default();
    let complaint = stderr.join().unwrap_or_default();
    if !status.success() {
        let tail = complaint
            .lines()
            .rev()
            .take(3)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join(" ");
        return Err(Error::new(
            ErrorCode::Io,
            format!(
                "your speech command could not read the recording: {}",
                tail.trim()
            ),
        ));
    }
    Ok(clean_transcript(&printed))
}

struct Loaded {
    context: WhisperContext,
    used: Instant,
}

/// The built-in engine: the model on disk, loaded when first needed and let go of when it has not
/// been used for a while, since it takes most of a gigabyte of memory.
pub struct Recognizer {
    dir: PathBuf,
    loaded: Mutex<Option<Loaded>>,
    downloading: AtomicBool,
    cancel: AtomicBool,
}

impl Recognizer {
    /// `dir` is where the model is kept.
    pub fn new(dir: PathBuf) -> Arc<Self> {
        // Whisper prints a lot to the terminal; the app does not want any of it.
        whisper_rs::install_logging_hooks();
        let this = Arc::new(Self {
            dir,
            loaded: Mutex::new(None),
            downloading: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
        });
        let weak: Weak<Self> = Arc::downgrade(&this);
        std::thread::spawn(move || {
            while let Some(this) = weak.upgrade() {
                {
                    let mut loaded = this.loaded.lock();
                    if loaded
                        .as_ref()
                        .is_some_and(|held| held.used.elapsed() > KEEP_LOADED)
                    {
                        *loaded = None;
                    }
                }
                drop(this);
                std::thread::sleep(Duration::from_secs(30));
            }
        });
        this
    }

    pub fn model_path(&self) -> PathBuf {
        self.dir.join(MODEL_FILE)
    }

    /// The model is on disk, whole.
    pub fn model_ready(&self) -> bool {
        std::fs::metadata(self.model_path()).is_ok_and(|meta| meta.len() >= MIN_MODEL_BYTES)
    }

    pub fn downloading(&self) -> bool {
        self.downloading.load(Ordering::SeqCst)
    }

    /// Stops a download in progress; what was fetched is kept to be resumed.
    pub fn cancel_download(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    /// Fetches the model into the folder, resuming a download that was interrupted. `progress` is
    /// told how much has arrived and how much there is, when the server says.
    pub fn download(&self, mut progress: impl FnMut(u64, Option<u64>)) -> Result<()> {
        if self.model_ready() {
            return Ok(());
        }
        if self.downloading.swap(true, Ordering::SeqCst) {
            return Err(Error::new(
                ErrorCode::Invalid,
                "the speech model is already being downloaded",
            ));
        }
        self.cancel.store(false, Ordering::SeqCst);
        let outcome = self.fetch(&mut progress);
        self.downloading.store(false, Ordering::SeqCst);
        outcome
    }

    fn fetch(&self, progress: &mut impl FnMut(u64, Option<u64>)) -> Result<()> {
        let io = |error: std::io::Error| Error::new(ErrorCode::Io, error.to_string());
        std::fs::create_dir_all(&self.dir).map_err(io)?;
        let part = self.dir.join(format!("{MODEL_FILE}.part"));
        let have = std::fs::metadata(&part).map(|meta| meta.len()).unwrap_or(0);
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(20)))
            .user_agent("ataraxia")
            .build()
            .into();
        let mut request = agent.get(MODEL_URL);
        if have > 0 {
            request = request.header("Range", format!("bytes={have}-"));
        }
        let response = request.call().map_err(|error| {
            Error::new(
                ErrorCode::Io,
                format!("could not download the speech model: {error}"),
            )
        })?;
        let resumed = response.status().as_u16() == 206;
        let length = response
            .headers()
            .get("content-length")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok());
        let start = if resumed { have } else { 0 };
        let total = length.map(|length| length + start);
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(resumed)
            .truncate(!resumed)
            .open(&part)
            .map_err(io)?;
        let mut body = response.into_body().into_reader();
        let mut received = start;
        let mut buffer = vec![0u8; 256 * 1024];
        let mut last = Instant::now();
        progress(received, total);
        loop {
            if self.cancel.load(Ordering::SeqCst) {
                return Err(Error::new(ErrorCode::Invalid, "the download was cancelled"));
            }
            let read = body.read(&mut buffer).map_err(|error| {
                Error::new(
                    ErrorCode::Io,
                    format!("the download was interrupted: {error}. Try again to resume it."),
                )
            })?;
            if read == 0 {
                break;
            }
            file.write_all(&buffer[..read]).map_err(io)?;
            received += read as u64;
            if last.elapsed() > Duration::from_millis(250) {
                progress(received, total);
                last = Instant::now();
            }
        }
        file.flush().map_err(io)?;
        drop(file);
        progress(received, total);
        check_model(&part)?;
        std::fs::rename(&part, self.model_path()).map_err(io)?;
        Ok(())
    }

    /// Turns a recording (16 kHz mono WAV) into text. `language` is an ISO code, or empty to let
    /// Whisper work it out.
    pub fn transcribe(&self, wav: &[u8], language: &str) -> Result<String> {
        let samples = wav_samples(wav)?;
        if !self.model_ready() {
            return Err(Error::new(
                ErrorCode::NotFound,
                "the speech model is not downloaded yet",
            ));
        }
        let mut loaded = self.loaded.lock();
        if loaded.is_none() {
            let path = self.model_path();
            let context =
                WhisperContext::new_with_params(&path, WhisperContextParameters::default())
                    .map_err(|error| {
                        Error::new(
                            ErrorCode::Io,
                            format!("could not load the speech model: {error}"),
                        )
                    })?;
            *loaded = Some(Loaded {
                context,
                used: Instant::now(),
            });
        }
        let held = loaded.as_mut().expect("loaded above");
        let mut state = held.context.create_state().map_err(|error| {
            Error::new(ErrorCode::Io, format!("could not start listening: {error}"))
        })?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        let language = language.trim();
        // "auto" makes Whisper work the language out. (`set_detect_language` would make it do only
        // that, and stop without transcribing.)
        params.set_language(Some(if language.is_empty() {
            "auto"
        } else {
            language
        }));
        params.set_translate(false);
        params.set_no_context(true);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        let threads = std::thread::available_parallelism()
            .map(|count| count.get())
            .unwrap_or(4)
            .min(8);
        params.set_n_threads(threads as i32);
        state.full(params, &samples).map_err(|error| {
            Error::new(
                ErrorCode::Io,
                format!("could not make out the recording: {error}"),
            )
        })?;
        let mut text = String::new();
        for segment in state.as_iter() {
            if let Ok(piece) = segment.to_str_lossy() {
                text.push_str(&piece);
                text.push(' ');
            }
        }
        held.used = Instant::now();
        Ok(clean_transcript(&text))
    }
}

/// A file that is a Whisper model: big enough, and starting with the `ggml` magic.
fn check_model(path: &Path) -> Result<()> {
    let io = |error: std::io::Error| Error::new(ErrorCode::Io, error.to_string());
    let size = std::fs::metadata(path).map_err(io)?.len();
    let mut magic = [0u8; 4];
    std::fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut magic))
        .map_err(io)?;
    // `ggml` written as a little-endian number, which is how the file starts.
    if size < MIN_MODEL_BYTES || &magic != b"lmgg" {
        let _ = std::fs::remove_file(path);
        return Err(Error::new(
            ErrorCode::Io,
            "what was downloaded is not the speech model, so it was deleted. Try again.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(len: usize) -> Vec<u8> {
        let mut bytes = b"RIFF\0\0\0\0WAVEfmt ".to_vec();
        bytes.resize(len, 0);
        bytes
    }

    /// A real 16 kHz mono 16-bit WAV holding `samples`.
    fn wav_of(samples: &[i16]) -> Vec<u8> {
        let data = samples.len() * 2;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data as u32).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&16000u32.to_le_bytes());
        bytes.extend_from_slice(&32000u32.to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&(data as u32).to_le_bytes());
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn what_whisper_adds_around_the_words_is_removed() {
        assert_eq!(
            clean_transcript(
                "[00:00:00.000 --> 00:00:03.000]   Hello there\n[BLANK_AUDIO]\n (music) \n and more\n"
            ),
            "Hello there and more"
        );
        assert_eq!(clean_transcript("  \n[SILENCE]\n"), "");
        assert_eq!(
            clean_transcript("keep [this] in the line"),
            "keep [this] in the line"
        );
    }

    #[test]
    fn only_a_wav_of_a_sensible_size_is_listened_to() {
        assert!(check_wav(&wav(100)).is_ok());
        assert!(
            check_wav(b"not audio at all, not audio at all, not audio at all, not audio at all")
                .is_err()
        );
        assert!(check_wav(&wav(10)).is_err());
        assert!(check_wav(&wav(MAX_WAV_BYTES + 1)).is_err());
    }

    #[test]
    fn the_samples_of_a_recording_are_read_as_floats() {
        let bytes = wav_of(&[
            0, 16384, -16384, 32767, -32768, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ]);
        let samples = wav_samples(&bytes).unwrap();
        assert_eq!(samples.len(), 23);
        assert_eq!(samples[0], 0.0);
        assert!((samples[1] - 0.5).abs() < 1e-6);
        assert!((samples[2] + 0.5).abs() < 1e-6);
        assert!((samples[4] + 1.0).abs() < 1e-6);
    }

    #[test]
    fn a_recording_that_is_not_16khz_mono_is_refused_with_the_reason() {
        let mut stereo = wav_of(&[0; 40]);
        stereo[22] = 2;
        let error = wav_samples(&stereo).unwrap_err();
        assert!(error.message.contains("16 kHz mono"), "{}", error.message);
        let mut fast = wav_of(&[0; 40]);
        fast[24..28].copy_from_slice(&44100u32.to_le_bytes());
        assert!(wav_samples(&fast).is_err());
        // A header with no audio after it.
        assert!(wav_samples(&wav(100)).is_err());
    }

    #[test]
    fn the_built_in_engine_is_the_default_and_a_command_of_ones_own_takes_its_place() {
        assert_eq!(detect(&Choice::default(), None).unwrap(), Engine::BuiltIn);
        let error = detect(
            &Choice {
                command: "/nowhere/listen {file}".into(),
                language: String::new(),
            },
            None,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::NotFound);
        assert!(error.message.contains("/nowhere/listen"));
    }

    #[cfg(unix)]
    #[test]
    fn a_command_of_the_persons_own_is_run_on_the_recording_and_its_output_cleaned() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("listen.sh");
        std::fs::write(
            &script,
            "#!/bin/sh\n[ -s \"$1\" ] || exit 3\necho '[00:00:00.000 --> 00:00:01.000]  open the settings'\necho '[BLANK_AUDIO]'\n",
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let engine = detect(
            &Choice {
                command: format!("{} {{file}}", script.display()),
                language: String::new(),
            },
            None,
        )
        .unwrap();
        let Engine::Custom { program, args } = engine else {
            panic!("a custom engine");
        };
        assert_eq!(
            transcribe_with_command(&program, &args, &wav(200)).unwrap(),
            "open the settings"
        );
        // A recording that is not audio never reaches the command.
        assert!(transcribe_with_command(&program, &args, b"hello").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_failing_command_says_what_it_complained_about() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("broken.sh");
        std::fs::write(
            &script,
            "#!/bin/sh\necho 'model file is corrupt' >&2\nexit 2\n",
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let error = transcribe_with_command(&script, &[], &wav(200)).unwrap_err();
        assert!(
            error.message.contains("model file is corrupt"),
            "{}",
            error.message
        );
    }

    #[test]
    fn a_file_is_the_model_only_when_it_is_big_and_starts_with_the_magic() {
        let dir = tempfile::tempdir().unwrap();
        let small = dir.path().join("small.bin");
        std::fs::write(&small, b"lmgg and then not much").unwrap();
        assert!(check_model(&small).is_err());
        assert!(!small.exists(), "a file that is not the model is deleted");
        // A sparse file stands in for the real size.
        let big = dir.path().join("big.bin");
        let mut file = std::fs::File::create(&big).unwrap();
        file.write_all(b"lmgg").unwrap();
        file.set_len(MIN_MODEL_BYTES + 1).unwrap();
        drop(file);
        assert!(check_model(&big).is_ok());
        let wrong = dir.path().join("wrong.bin");
        let mut file = std::fs::File::create(&wrong).unwrap();
        file.write_all(b"<htm").unwrap();
        file.set_len(MIN_MODEL_BYTES + 1).unwrap();
        drop(file);
        assert!(check_model(&wrong).is_err());
    }

    #[test]
    fn the_model_counts_as_ready_only_when_it_is_whole_and_listening_without_it_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let recognizer = Recognizer::new(dir.path().to_path_buf());
        assert!(!recognizer.model_ready());
        std::fs::write(recognizer.model_path(), b"truncated").unwrap();
        assert!(!recognizer.model_ready());
        let error = recognizer.transcribe(&wav_of(&[0; 4000]), "").unwrap_err();
        assert_eq!(error.code, ErrorCode::NotFound);
        assert!(!recognizer.downloading());
    }

    /// Downloads the real model and listens to a real recording. It is a gigabyte of network and a
    /// few seconds of CPU, so it only runs when asked for:
    /// `ATARAXIA_SPEECH_WAV=/path/16k-mono.wav cargo test --lib real_model -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_model_downloads_and_listens() {
        let wav =
            std::fs::read(std::env::var("ATARAXIA_SPEECH_WAV").expect("a recording")).unwrap();
        let dir = std::env::var_os("ATARAXIA_SPEECH_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("ataraxia-speech-test"));
        let recognizer = Recognizer::new(dir);
        let mut last = 0;
        recognizer
            .download(|received, total| {
                if received / 50_000_000 != last / 50_000_000 {
                    println!("downloaded {received} of {total:?}");
                }
                last = received;
            })
            .unwrap();
        assert!(recognizer.model_ready());
        let started = Instant::now();
        let text = recognizer.transcribe(&wav, "").unwrap();
        println!("heard {text:?} in {:?}", started.elapsed());
        assert!(!text.is_empty());
    }
}
