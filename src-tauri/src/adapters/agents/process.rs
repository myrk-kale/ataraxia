//! Child-process plumbing shared by the CLI-backed providers.
//!
//! Provides binary discovery (GUI apps start with a minimal `PATH`), a line-oriented
//! process wrapper with stdout/stderr readers, and a small stderr tail for error messages.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use parking_lot::Mutex;

use crate::domain::{Error, ErrorCode, Result};

const STDERR_TAIL_LINES: usize = 20;
/// Set to a file path to append every line exchanged with a provider CLI (`<` from it, `>` to
/// it). Off by default: the log holds the full conversation.
const DEBUG_FRAMES_ENV: &str = "ATARAXIA_DEBUG_FRAMES";

fn debug_frame(direction: char, program: &Path, line: &str) {
    let Some(path) = std::env::var_os(DEBUG_FRAMES_ENV) else {
        return;
    };
    let name = program
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "{direction} {name} {line}");
    }
}

/// Directories where user-installed agent CLIs commonly live.
fn well_known_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for relative in [
            ".opencode/bin",
            ".local/bin",
            ".cargo/bin",
            ".bun/bin",
            ".npm-global/bin",
            ".volta/bin",
            ".claude/local",
        ] {
            dirs.push(home.join(relative));
        }
    }
    for absolute in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
        dirs.push(PathBuf::from(absolute));
    }
    dirs
}

fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    for dir in well_known_dirs() {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs
}

fn is_executable_file(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

/// Resolves a CLI by name. `override_env` lets users pin an explicit path.
pub fn resolve_binary(name: &str, override_env: &str) -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os(override_env).map(PathBuf::from) {
        if is_executable_file(&explicit) {
            return Some(explicit);
        }
    }
    search_dirs()
        .into_iter()
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable_file(candidate))
}

/// `PATH` for children: the current one plus the well-known install dirs.
pub fn enriched_path() -> OsString {
    std::env::join_paths(search_dirs())
        .unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

#[derive(Debug, Clone)]
pub struct SpawnSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    /// Variables to strip (e.g. markers that make a CLI refuse to run nested).
    pub env_remove: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExitInfo {
    pub code: Option<i32>,
    pub stderr_tail: String,
}

impl ExitInfo {
    pub fn describe(&self, name: &str) -> String {
        let code = self
            .code
            .map(|code| format!(" (exit code {code})"))
            .unwrap_or_default();
        if self.stderr_tail.trim().is_empty() {
            format!("{name} exited{code}")
        } else {
            format!("{name} exited{code}: {}", self.stderr_tail.trim())
        }
    }
}

pub struct ManagedProcess {
    program: PathBuf,
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
    alive: Arc<AtomicBool>,
}

impl ManagedProcess {
    /// Spawns the process; `on_line` runs on the stdout reader thread for every line and
    /// `on_exit` runs once after stdout closes.
    pub fn spawn(
        spec: &SpawnSpec,
        on_line: impl Fn(String) + Send + 'static,
        on_exit: impl FnOnce(ExitInfo) + Send + 'static,
    ) -> Result<Arc<Self>> {
        let mut command = Command::new(&spec.program);
        command
            .args(&spec.args)
            .current_dir(&spec.cwd)
            .env("PATH", enriched_path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for key in &spec.env_remove {
            command.env_remove(key);
        }
        for (key, value) in &spec.env {
            command.env(key, value);
        }
        let mut child = command.spawn().map_err(|error| {
            Error::new(
                ErrorCode::Agent,
                format!("could not start {}: {error}", spec.program.display()),
            )
        })?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Error::new(ErrorCode::Agent, "child stdout unavailable"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| Error::new(ErrorCode::Agent, "child stderr unavailable"))?;
        let stdin = child.stdin.take();

        let tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
        let stderr_tail = Arc::clone(&tail);
        let stderr_thread = thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(|line| line.ok()) {
                let mut tail = stderr_tail.lock();
                if tail.len() == STDERR_TAIL_LINES {
                    tail.pop_front();
                }
                tail.push_back(line);
            }
        });

        let process = Arc::new(Self {
            program: spec.program.clone(),
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            alive: Arc::new(AtomicBool::new(true)),
        });

        let watcher = Arc::clone(&process);
        let program = spec.program.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(|line| line.ok()) {
                if !line.trim().is_empty() {
                    debug_frame('<', &program, &line);
                    on_line(line);
                }
            }
            let _ = stderr_thread.join();
            // Poll instead of blocking in `wait()` so `kill()` never contends for the lock.
            let code = loop {
                match watcher.child.lock().try_wait() {
                    Ok(Some(status)) => break status.code(),
                    Ok(None) => {}
                    Err(_) => break None,
                }
                thread::sleep(Duration::from_millis(20));
            };
            watcher.alive.store(false, Ordering::SeqCst);
            let stderr_tail = tail.lock().iter().cloned().collect::<Vec<_>>().join("\n");
            on_exit(ExitInfo { code, stderr_tail });
        });
        Ok(process)
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    pub fn write_line(&self, line: &str) -> Result<()> {
        debug_frame('>', &self.program, line);
        let mut guard = self.stdin.lock();
        let stdin = guard
            .as_mut()
            .ok_or_else(|| Error::new(ErrorCode::Agent, "agent process closed its input"))?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|()| stdin.write_all(b"\n"))
            .and_then(|()| stdin.flush())
            .map_err(|error| {
                Error::new(ErrorCode::Agent, format!("write to agent failed: {error}"))
            })
    }

    /// Closes stdin and kills the child. Idempotent.
    pub fn kill(&self) {
        self.stdin.lock().take();
        let _ = self.child.lock().kill();
    }
}

impl Drop for ManagedProcess {
    fn drop(&mut self) {
        self.stdin.get_mut().take();
        let _ = self.child.get_mut().kill();
    }
}
