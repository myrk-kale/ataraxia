//! Keeping the machine awake, per platform.
//!
//! macOS and Linux hold a helper process that blocks idle sleep for as long as it lives and is
//! killed when the hold ends. On macOS `caffeinate -w` also ends it if the app dies; on Linux
//! the helper is killed on drop. Windows sets the execution state of the calling thread.

use crate::ports::SleepGuard;

#[cfg(unix)]
mod imp {
    use std::process::{Child, Command, Stdio};

    use parking_lot::Mutex;

    #[derive(Default)]
    pub struct Hold {
        child: Mutex<Option<Child>>,
    }

    #[cfg(target_os = "macos")]
    fn spawn() -> std::io::Result<Child> {
        Command::new("caffeinate")
            .args(["-i", "-w", &std::process::id().to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
    }

    #[cfg(not(target_os = "macos"))]
    fn spawn() -> std::io::Result<Child> {
        Command::new("systemd-inhibit")
            .args([
                "--what=idle:sleep",
                "--who=Ataraxia",
                "--why=Agents have work in progress",
                "--mode=block",
                "sleep",
                "infinity",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
    }

    impl Hold {
        pub fn set(&self, awake: bool) {
            let mut child = self.child.lock();
            if let Some(running) = child.as_mut() {
                // The helper may have died on its own; a dead one is not a hold.
                if !matches!(running.try_wait(), Ok(None)) {
                    *child = None;
                }
            }
            match (awake, child.is_some()) {
                (true, false) => match spawn() {
                    Ok(started) => *child = Some(started),
                    Err(error) => eprintln!("ataraxia: could not keep the system awake: {error}"),
                },
                (false, true) => {
                    if let Some(mut running) = child.take() {
                        let _ = running.kill();
                        let _ = running.wait();
                    }
                }
                _ => {}
            }
        }
    }

    impl Drop for Hold {
        fn drop(&mut self) {
            self.set(false);
        }
    }
}

#[cfg(windows)]
mod imp {
    const ES_CONTINUOUS: u32 = 0x8000_0000;
    const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn SetThreadExecutionState(flags: u32) -> u32;
    }

    #[derive(Default)]
    pub struct Hold;

    impl Hold {
        /// The state belongs to the calling thread, which is always the guard's own.
        pub fn set(&self, awake: bool) {
            let flags = if awake {
                ES_CONTINUOUS | ES_SYSTEM_REQUIRED
            } else {
                ES_CONTINUOUS
            };
            // SAFETY: plain Win32 call with valid flags.
            unsafe {
                SetThreadExecutionState(flags);
            }
        }
    }
}

#[derive(Default)]
pub struct SystemSleepGuard {
    hold: imp::Hold,
}

impl SleepGuard for SystemSleepGuard {
    fn hold(&self, awake: bool) {
        self.hold.set(awake);
    }
}
