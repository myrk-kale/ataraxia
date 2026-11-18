//! Speech to text, on this computer: what the person says into the message field becomes text with
//! a Whisper engine they have installed (the `turbo` model, large-v3-turbo). Nothing is sent
//! anywhere: the recording goes to a temporary file, an engine reads it, the file is deleted.
//!
//! Engines, in the order they are tried:
//! - a command the person set (`{file}` stands for the recording; it prints the text),
//! - `whisper-cli` / `whisper-cpp` (whisper.cpp) with a large-v3-turbo model file,
//! - `mlx_whisper` (Apple silicon) with `mlx-community/whisper-large-v3-turbo`,
//! - `whisper` (OpenAI's Python package) with `--model turbo`.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::adapters::agents::process::{enriched_path, resolve_program};
use crate::domain::{Error, ErrorCode, Result, parse_command};

/// Preference keys under which the person's choices are kept.
pub const PREF_COMMAND: &str = "speech.command";
pub const PREF_MODEL: &str = "speech.model";

/// A recording longer than this is refused: a message, not a lecture.
const MAX_WAV_BYTES: usize = 40 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(180);

const MLX_MODEL: &str = "mlx-community/whisper-large-v3-turbo";

pub const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Engine {
    /// A command the person wrote; `{file}` is replaced by the recording.
    Custom {
        program: PathBuf,
        args: Vec<String>,
    },
    WhisperCpp {
        program: PathBuf,
        model: PathBuf,
    },
    MlxWhisper {
        program: PathBuf,
    },
    OpenAiWhisper {
        program: PathBuf,
    },
}

impl Engine {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Custom { .. } => "your command",
            Self::WhisperCpp { .. } => "whisper.cpp",
            Self::MlxWhisper { .. } => "mlx-whisper",
            Self::OpenAiWhisper { .. } => "whisper",
        }
    }
}

/// What the person set; empty means "find one".
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Choice {
    pub command: String,
    pub model: String,
}

fn program(names: &[&str]) -> Option<PathBuf> {
    names.iter().find_map(|name| {
        resolve_program(name).or_else(|| {
            cfg!(windows)
                .then(|| resolve_program(&format!("{name}.exe")))
                .flatten()
        })
    })
}

/// Where a whisper.cpp model may be kept, most likely first.
fn model_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = home {
        for relative in [
            ".cache/whisper",
            ".cache/whisper.cpp",
            ".cache/whisper-cpp",
            "whisper.cpp/models",
            "models",
            "Library/Application Support/whisper",
            "Library/Application Support/whisper.cpp",
            "Library/Application Support/MacWhisper/models",
            ".local/share/whisper",
            ".local/share/whisper.cpp",
        ] {
            dirs.push(home.join(relative));
        }
    }
    for fixed in [
        "/opt/homebrew/share/whisper-cpp",
        "/opt/homebrew/share/whisper.cpp",
        "/usr/local/share/whisper-cpp",
        "/usr/local/share/whisper.cpp",
        "/usr/share/whisper.cpp",
    ] {
        dirs.push(PathBuf::from(fixed));
    }
    dirs
}

/// The turbo model first, then any other multilingual model, never an English-only one.
pub fn pick_model(files: &[String]) -> Option<String> {
    let usable = |name: &&String| {
        let lower = name.to_lowercase();
        lower.starts_with("ggml-") && lower.ends_with(".bin") && !lower.contains(".en")
    };
    files
        .iter()
        .filter(usable)
        .find(|name| name.to_lowercase().contains("large-v3-turbo"))
        .or_else(|| {
            files
                .iter()
                .filter(usable)
                .find(|name| name.to_lowercase().contains("turbo"))
        })
        .or_else(|| files.iter().find(usable))
        .cloned()
}

fn find_model(explicit: &str, home: Option<&Path>) -> Option<PathBuf> {
    let explicit = explicit.trim();
    if !explicit.is_empty() {
        let path = expand(explicit, home);
        return path.is_file().then_some(path);
    }
    if let Some(from_env) = std::env::var_os("WHISPER_MODEL").map(PathBuf::from) {
        if from_env.is_file() {
            return Some(from_env);
        }
    }
    for dir in model_dirs(home) {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let names: Vec<String> = entries
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        if let Some(name) = pick_model(&names) {
            return Some(dir.join(name));
        }
    }
    None
}

fn expand(text: &str, home: Option<&Path>) -> PathBuf {
    match (text.strip_prefix("~/"), home) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(text),
    }
}

/// Finds the engine to use, or says what to install.
pub fn detect(choice: &Choice, home: Option<&Path>) -> Result<Engine> {
    let command = choice.command.trim();
    if !command.is_empty() {
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
        return Ok(Engine::Custom {
            program,
            args: parsed.args,
        });
    }
    if let Some(program) = program(&["whisper-cli", "whisper-cpp"]) {
        return match find_model(&choice.model, home) {
            Some(model) => Ok(Engine::WhisperCpp { program, model }),
            None => Err(Error::new(
                ErrorCode::NotFound,
                format!(
                    "whisper.cpp is installed but has no model. Download the turbo one: \
                     `mkdir -p ~/.cache/whisper && curl -L {MODEL_URL} -o ~/.cache/whisper/ggml-large-v3-turbo.bin`, \
                     or choose a model file in Settings > Voice."
                ),
            )),
        };
    }
    if let Some(program) = program(&["mlx_whisper"]) {
        return Ok(Engine::MlxWhisper { program });
    }
    if let Some(program) = program(&["whisper"]) {
        return Ok(Engine::OpenAiWhisper { program });
    }
    Err(Error::new(
        ErrorCode::NotFound,
        "no Whisper engine found. Install one: `brew install whisper-cpp` (then download the turbo \
         model), `pip install mlx-whisper` on a Mac with Apple silicon, or `pip install openai-whisper`; \
         or set your own command in Settings > Voice.",
    ))
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

/// The arguments an engine is run with for a recording, and where it leaves its text.
struct Plan {
    args: Vec<String>,
    /// A file the engine writes the text to; otherwise the text is what it prints.
    output: Option<PathBuf>,
}

fn plan(engine: &Engine, wav: &Path, dir: &Path) -> Plan {
    let file = wav.to_string_lossy().into_owned();
    let stem = wav
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    match engine {
        Engine::Custom { args, .. } => {
            let mut args: Vec<String> = args
                .iter()
                .map(|arg| arg.replace("{file}", &file))
                .collect();
            if !args.iter().any(|arg| arg.contains(&file)) {
                args.push(file);
            }
            Plan { args, output: None }
        }
        Engine::WhisperCpp { model, .. } => Plan {
            args: vec![
                "-m".into(),
                model.to_string_lossy().into_owned(),
                "-f".into(),
                file,
                "-nt".into(),
                "-np".into(),
                "-l".into(),
                "auto".into(),
            ],
            output: None,
        },
        Engine::MlxWhisper { .. } => Plan {
            args: vec![
                file,
                "--model".into(),
                MLX_MODEL.into(),
                "--output-format".into(),
                "txt".into(),
                "--output-dir".into(),
                dir.to_string_lossy().into_owned(),
            ],
            output: Some(dir.join(format!("{stem}.txt"))),
        },
        Engine::OpenAiWhisper { .. } => Plan {
            args: vec![
                file,
                "--model".into(),
                "turbo".into(),
                "--output_format".into(),
                "txt".into(),
                "--output_dir".into(),
                dir.to_string_lossy().into_owned(),
                "--fp16".into(),
                "False".into(),
                "--verbose".into(),
                "False".into(),
            ],
            output: Some(dir.join(format!("{stem}.txt"))),
        },
    }
}

fn program_of(engine: &Engine) -> &Path {
    match engine {
        Engine::Custom { program, .. }
        | Engine::WhisperCpp { program, .. }
        | Engine::MlxWhisper { program }
        | Engine::OpenAiWhisper { program } => program,
    }
}

fn drain(mut source: impl Read + Send + 'static) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = source.read_to_end(&mut bytes);
        String::from_utf8_lossy(&bytes).into_owned()
    })
}

/// Turns a recording into text. The recording lives in a private temporary folder for as long as
/// the engine needs it.
pub fn transcribe(engine: &Engine, wav: &[u8]) -> Result<String> {
    check_wav(wav)?;
    let dir = tempfile::Builder::new()
        .prefix("ataraxia-speech-")
        .tempdir()
        .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
    let file = dir.path().join("recording.wav");
    std::fs::write(&file, wav).map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
    let plan = plan(engine, &file, dir.path());
    let mut child = Command::new(program_of(engine))
        .args(&plan.args)
        .current_dir(dir.path())
        .env("PATH", enriched_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            Error::new(
                ErrorCode::Io,
                format!("could not start {}: {error}", engine.name()),
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
                    format!("{} took too long to listen", engine.name()),
                ));
            }
            Err(error) => return Err(Error::new(ErrorCode::Io, error.to_string())),
        }
    };
    let printed = stdout.join().unwrap_or_default();
    let complaint = stderr.join().unwrap_or_default();
    if !status.success() {
        let tail: String = complaint
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
                "{} could not read the recording: {}",
                engine.name(),
                tail.trim()
            ),
        ));
    }
    let text = match &plan.output {
        Some(path) => std::fs::read_to_string(path).unwrap_or(printed),
        None => printed,
    };
    Ok(clean_transcript(&text))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(len: usize) -> Vec<u8> {
        let mut bytes = b"RIFF\0\0\0\0WAVEfmt ".to_vec();
        bytes.resize(len, 0);
        bytes
    }

    #[test]
    fn the_turbo_model_is_preferred_and_english_only_ones_never_are() {
        let names = |list: &[&str]| list.iter().map(|name| name.to_string()).collect::<Vec<_>>();
        assert_eq!(
            pick_model(&names(&[
                "ggml-base.bin",
                "ggml-large-v3-turbo-q5_0.bin",
                "ggml-small.bin"
            ])),
            Some("ggml-large-v3-turbo-q5_0.bin".into())
        );
        assert_eq!(
            pick_model(&names(&["ggml-base.en.bin", "ggml-small.bin"])),
            Some("ggml-small.bin".into())
        );
        assert_eq!(pick_model(&names(&["ggml-base.en.bin", "notes.txt"])), None);
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
    fn each_engine_is_run_the_way_it_wants() {
        let dir = Path::new("/tmp/x");
        let file = dir.join("recording.wav");
        let cpp = plan(
            &Engine::WhisperCpp {
                program: "/bin/whisper-cli".into(),
                model: "/m/ggml-large-v3-turbo.bin".into(),
            },
            &file,
            dir,
        );
        assert!(
            cpp.args
                .windows(2)
                .any(|pair| pair == ["-m", "/m/ggml-large-v3-turbo.bin"])
        );
        assert!(cpp.args.contains(&"-nt".to_string()));
        assert!(cpp.output.is_none());
        let openai = plan(
            &Engine::OpenAiWhisper {
                program: "/bin/whisper".into(),
            },
            &file,
            dir,
        );
        assert!(
            openai
                .args
                .windows(2)
                .any(|pair| pair == ["--model", "turbo"])
        );
        assert_eq!(openai.output, Some(dir.join("recording.txt")));
        let mlx = plan(
            &Engine::MlxWhisper {
                program: "/bin/mlx_whisper".into(),
            },
            &file,
            dir,
        );
        assert!(mlx.args.contains(&MLX_MODEL.to_string()));
        // A command of the person's own gets the file where it says, or at the end.
        let custom = plan(
            &Engine::Custom {
                program: "/bin/say".into(),
                args: vec!["--in".into(), "{file}".into()],
            },
            &file,
            dir,
        );
        assert_eq!(
            custom.args,
            vec!["--in".to_string(), file.to_string_lossy().into_owned()]
        );
        let bare = plan(
            &Engine::Custom {
                program: "/bin/say".into(),
                args: vec![],
            },
            &file,
            dir,
        );
        assert_eq!(bare.args, vec![file.to_string_lossy().into_owned()]);
    }

    #[cfg(unix)]
    #[test]
    fn a_command_of_the_persons_own_is_run_on_the_recording_and_its_output_cleaned() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("listen.sh");
        std::fs::write(
            &script,
            "#!/bin/sh\n# prints what a model would, given the file it was handed\n[ -s \"$1\" ] || exit 3\necho '[00:00:00.000 --> 00:00:01.000]  open the settings'\necho '[BLANK_AUDIO]'\n",
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let engine = detect(
            &Choice {
                command: format!("{} {{file}}", script.display()),
                model: String::new(),
            },
            None,
        )
        .unwrap();
        assert_eq!(engine.name(), "your command");
        assert_eq!(transcribe(&engine, &wav(200)).unwrap(), "open the settings");
        // A recording that is not audio never reaches the engine.
        assert!(transcribe(&engine, b"hello").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_failing_engine_says_what_it_complained_about() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("broken.sh");
        std::fs::write(
            &script,
            "#!/bin/sh\necho 'model file is corrupt' >&2\nexit 2\n",
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let engine = Engine::Custom {
            program: script,
            args: vec![],
        };
        let error = transcribe(&engine, &wav(200)).unwrap_err();
        assert!(
            error.message.contains("model file is corrupt"),
            "{}",
            error.message
        );
    }

    #[test]
    fn a_missing_custom_program_is_named() {
        let error = detect(
            &Choice {
                command: "/nowhere/listen {file}".into(),
                model: String::new(),
            },
            None,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::NotFound);
        assert!(error.message.contains("/nowhere/listen"));
    }
}
