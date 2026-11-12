//! portable-pty backed host: one session per worktree.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use base64::Engine as _;
use parking_lot::Mutex;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::domain::ids::{PtySessionId, WorktreeId};
use crate::domain::{Error, ErrorCode, Result};
use crate::ports::{PtyEnsureResponse, PtyHost, PtySpawnRequest};

const REPLAY_CAPACITY: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputEvent {
    pub worktree_id: WorktreeId,
    pub session_id: PtySessionId,
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitEvent {
    pub worktree_id: WorktreeId,
    pub session_id: PtySessionId,
    pub code: Option<u32>,
}

struct LiveSession {
    session_id: PtySessionId,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Box<dyn MasterPty + Send>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    reader: Option<JoinHandle<()>>,
    waiter: Option<JoinHandle<()>>,
    stop: Arc<AtomicBool>,
    replay: VecDeque<u8>,
}

struct Inner {
    sessions: HashMap<WorktreeId, LiveSession>,
    by_session: HashMap<PtySessionId, WorktreeId>,
}

pub struct NativePtyHost {
    app: AppHandle,
    inner: Arc<Mutex<Inner>>,
}

impl NativePtyHost {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            inner: Arc::new(Mutex::new(Inner {
                sessions: HashMap::new(),
                by_session: HashMap::new(),
            })),
        }
    }

    pub fn shutdown_all(&self) {
        let ids: Vec<PtySessionId> = self.inner.lock().by_session.keys().copied().collect();
        for id in ids {
            let _ = self.kill(&id);
        }
    }

    fn push_replay(replay: &mut VecDeque<u8>, bytes: &[u8]) {
        for byte in bytes {
            if replay.len() >= REPLAY_CAPACITY {
                replay.pop_front();
            }
            replay.push_back(*byte);
        }
    }

    fn spawn_shell(
        cwd: &PathBuf,
        cols: u16,
        rows: u16,
    ) -> Result<(
        Box<dyn MasterPty + Send>,
        Box<dyn Write + Send>,
        Box<dyn ChildKiller + Send + Sync>,
        Box<dyn portable_pty::Child + Send + Sync>,
        Box<dyn Read + Send>,
    )> {
        let system = native_pty_system();
        let pair = system
            .openpty(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;

        let mut cmd = default_shell_command();
        cmd.cwd(cwd);

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
        let killer = child.clone_killer();
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;

        Ok((pair.master, writer, killer, child, reader))
    }
}

impl PtyHost for NativePtyHost {
    fn supported(&self) -> bool {
        true
    }

    fn ensure_session(&self, req: PtySpawnRequest) -> Result<PtyEnsureResponse> {
        if !req.cwd.is_dir() {
            return Err(Error::new(
                ErrorCode::Invalid,
                format!("cwd is not a directory: {}", req.cwd.display()),
            ));
        }

        {
            let inner = self.inner.lock();
            if let Some(existing) = inner.sessions.get(&req.worktree_id) {
                return Ok(PtyEnsureResponse {
                    session_id: existing.session_id,
                    created: false,
                    replay: existing.replay.iter().copied().collect(),
                });
            }
        }

        let session_id = PtySessionId::new();
        let (master, writer, killer, mut child, mut reader) =
            Self::spawn_shell(&req.cwd, req.cols, req.rows)?;
        let stop = Arc::new(AtomicBool::new(false));

        let inner = Arc::clone(&self.inner);
        let app = self.app.clone();
        let worktree_id = req.worktree_id;
        let stop_reader = Arc::clone(&stop);
        let reader_handle = thread::spawn(move || {
            let mut buf = [0_u8; 4096];
            while !stop_reader.load(Ordering::SeqCst) {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let chunk = &buf[..n];
                        {
                            let mut guard = inner.lock();
                            if let Some(session) = guard.sessions.get_mut(&worktree_id) {
                                NativePtyHost::push_replay(&mut session.replay, chunk);
                            }
                        }
                        let data = base64::engine::general_purpose::STANDARD.encode(chunk);
                        let _ = app.emit(
                            "terminal://output",
                            TerminalOutputEvent {
                                worktree_id,
                                session_id,
                                data,
                            },
                        );
                    }
                    Err(_) => break,
                }
            }
        });

        let app = self.app.clone();
        let stop_waiter = Arc::clone(&stop);
        let waiter_handle = thread::spawn(move || {
            loop {
                if stop_waiter.load(Ordering::SeqCst) {
                    break;
                }
                match child.try_wait() {
                    Ok(Some(status)) => {
                        let _ = app.emit(
                            "terminal://exit",
                            TerminalExitEvent {
                                worktree_id,
                                session_id,
                                code: Some(status.exit_code()),
                            },
                        );
                        break;
                    }
                    Ok(None) => thread::sleep(Duration::from_millis(50)),
                    Err(_) => {
                        let _ = app.emit(
                            "terminal://exit",
                            TerminalExitEvent {
                                worktree_id,
                                session_id,
                                code: None,
                            },
                        );
                        break;
                    }
                }
            }
        });

        let live = LiveSession {
            session_id,
            writer: Mutex::new(writer),
            master,
            killer: Mutex::new(killer),
            reader: Some(reader_handle),
            waiter: Some(waiter_handle),
            stop,
            replay: VecDeque::new(),
        };

        let mut inner = self.inner.lock();
        inner.by_session.insert(session_id, req.worktree_id);
        inner.sessions.insert(req.worktree_id, live);

        Ok(PtyEnsureResponse {
            session_id,
            created: true,
            replay: Vec::new(),
        })
    }

    fn write(&self, id: &PtySessionId, bytes: &[u8]) -> Result<()> {
        let mut inner = self.inner.lock();
        let worktree_id = *inner
            .by_session
            .get(id)
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "terminal session not found"))?;
        let session = inner
            .sessions
            .get_mut(&worktree_id)
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "terminal session not found"))?;
        let mut writer = session.writer.lock();
        writer
            .write_all(bytes)
            .and_then(|()| writer.flush())
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))
    }

    fn resize(&self, id: &PtySessionId, cols: u16, rows: u16) -> Result<()> {
        let inner = self.inner.lock();
        let worktree_id = *inner
            .by_session
            .get(id)
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "terminal session not found"))?;
        let session = inner
            .sessions
            .get(&worktree_id)
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "terminal session not found"))?;
        session
            .master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))
    }

    fn kill(&self, id: &PtySessionId) -> Result<()> {
        let mut session = {
            let mut inner = self.inner.lock();
            let worktree_id = inner
                .by_session
                .remove(id)
                .ok_or_else(|| Error::new(ErrorCode::NotFound, "terminal session not found"))?;
            match inner.sessions.remove(&worktree_id) {
                Some(session) => session,
                None => return Ok(()),
            }
        };

        session.stop.store(true, Ordering::SeqCst);
        let _ = session.killer.lock().kill();
        if let Some(reader) = session.reader.take() {
            let _ = reader.join();
        }
        if let Some(waiter) = session.waiter.take() {
            let _ = waiter.join();
        }
        Ok(())
    }
}

fn default_shell_command() -> CommandBuilder {
    #[cfg(windows)]
    {
        return CommandBuilder::new_default_prog();
    }
    #[cfg(not(windows))]
    {
        if let Ok(shell) = std::env::var("SHELL") {
            if !shell.trim().is_empty() {
                let mut cmd = CommandBuilder::new(shell);
                cmd.env("TERM", "xterm-256color");
                return cmd;
            }
        }
        let mut cmd = CommandBuilder::new("zsh");
        cmd.env("TERM", "xterm-256color");
        cmd
    }
}
