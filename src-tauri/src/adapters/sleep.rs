//! Keeping the machine awake, per platform, as Settings says: not at all, the system only, or
//! the system and the display.
//!
//! macOS holds an IOKit assertion. Linux holds a systemd inhibitor process. Windows sets the
//! execution state of the calling thread.

use std::sync::atomic::{AtomicU8, Ordering};

use serde::{Deserialize, Serialize};

use crate::ports::SleepGuard;

/// What the app keeps on while it has work in progress.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WakeMode {
    /// The machine sleeps on its own clock, work or not.
    Off,
    /// The machine stays awake; the display may turn off and lock.
    System,
    /// The machine and the display stay on.
    Display,
}

impl WakeMode {
    pub const DEFAULT: Self = Self::Display;

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::System => "system",
            Self::Display => "display",
        }
    }

    /// A saved value; anything unknown reads as the default.
    pub fn parse(value: &str) -> Self {
        match value.trim() {
            "off" => Self::Off,
            "system" => Self::System,
            "display" => Self::Display,
            _ => Self::DEFAULT,
        }
    }

    fn from_u8(value: u8) -> Self {
        match value {
            0 => Self::Off,
            1 => Self::System,
            _ => Self::Display,
        }
    }

    fn to_u8(self) -> u8 {
        match self {
            Self::Off => 0,
            Self::System => 1,
            Self::Display => 2,
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};
    use parking_lot::Mutex;

    const ASSERTION_LEVEL_ON: u32 = 255;

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: CFStringRef,
            level: u32,
            name: CFStringRef,
            id: *mut u32,
        ) -> i32;
        fn IOPMAssertionRelease(id: u32) -> i32;
    }

    struct Assertion {
        id: u32,
        display: bool,
    }

    impl Assertion {
        fn acquire(display: bool) -> Result<Self, i32> {
            // Both apply on battery and AC. The display one also keeps the system from idle
            // sleep; the system one lets the screen go dark and lock.
            let kind = CFString::new(if display {
                "PreventUserIdleDisplaySleep"
            } else {
                "PreventUserIdleSystemSleep"
            });
            let name = CFString::new("Ataraxia has work in progress");
            let mut id = 0;
            // SAFETY: Both strings and the writable output slot live through the call.
            let result = unsafe {
                IOPMAssertionCreateWithName(
                    kind.as_concrete_TypeRef(),
                    ASSERTION_LEVEL_ON,
                    name.as_concrete_TypeRef(),
                    &mut id,
                )
            };
            if result == 0 {
                Ok(Self { id, display })
            } else {
                Err(result)
            }
        }
    }

    impl Drop for Assertion {
        fn drop(&mut self) {
            // SAFETY: This ID came from a successful acquisition and is released once.
            let result = unsafe { IOPMAssertionRelease(self.id) };
            if result != 0 {
                eprintln!("ataraxia: could not release the sleep assertion: {result:#x}");
            }
        }
    }

    #[derive(Default)]
    pub struct Hold {
        assertion: Mutex<Option<Assertion>>,
    }

    impl Hold {
        pub fn set(&self, awake: bool, display: bool) {
            let mut assertion = self.assertion.lock();
            if assertion
                .as_ref()
                .is_some_and(|held| held.display != display)
            {
                *assertion = None;
            }
            if !awake {
                *assertion = None;
            } else if assertion.is_none() {
                match Assertion::acquire(display) {
                    Ok(acquired) => *assertion = Some(acquired),
                    Err(error) => {
                        eprintln!("ataraxia: could not keep the system awake: {error:#x}")
                    }
                }
            }
        }
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod imp {
    use std::process::{Child, Command, Stdio};

    use parking_lot::Mutex;

    #[derive(Default)]
    pub struct Hold {
        child: Mutex<Option<(Child, bool)>>,
    }

    fn spawn(display: bool) -> std::io::Result<Child> {
        // `idle` keeps the screen from blanking; `sleep` keeps the machine up.
        let what = if display {
            "--what=idle:sleep"
        } else {
            "--what=sleep"
        };
        Command::new("systemd-inhibit")
            .args([
                what,
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
        pub fn set(&self, awake: bool, display: bool) {
            let mut child = self.child.lock();
            if let Some((running, held)) = child.as_mut() {
                // The helper may have died on its own; a dead one is not a hold. One holding
                // the other kind goes too.
                if !matches!(running.try_wait(), Ok(None)) {
                    *child = None;
                } else if *held != display || !awake {
                    let _ = running.kill();
                    let _ = running.wait();
                    *child = None;
                }
            }
            if awake && child.is_none() {
                match spawn(display) {
                    Ok(started) => *child = Some((started, display)),
                    Err(error) => eprintln!("ataraxia: could not keep the system awake: {error}"),
                }
            }
        }
    }

    impl Drop for Hold {
        fn drop(&mut self) {
            self.set(false, false);
        }
    }
}

#[cfg(windows)]
mod imp {
    const ES_CONTINUOUS: u32 = 0x8000_0000;
    const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
    const ES_DISPLAY_REQUIRED: u32 = 0x0000_0002;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn SetThreadExecutionState(flags: u32) -> u32;
    }

    #[derive(Default)]
    pub struct Hold;

    impl Hold {
        /// The state belongs to the calling thread, which is always the guard's own.
        pub fn set(&self, awake: bool, display: bool) {
            let flags = match (awake, display) {
                (true, true) => ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED,
                (true, false) => ES_CONTINUOUS | ES_SYSTEM_REQUIRED,
                (false, _) => ES_CONTINUOUS,
            };
            // SAFETY: plain Win32 call with valid flags.
            unsafe {
                SetThreadExecutionState(flags);
            }
        }
    }
}

pub struct SystemSleepGuard {
    hold: imp::Hold,
    mode: AtomicU8,
}

impl SystemSleepGuard {
    pub fn new(mode: WakeMode) -> Self {
        Self {
            hold: imp::Hold::default(),
            mode: AtomicU8::new(mode.to_u8()),
        }
    }

    pub fn mode(&self) -> WakeMode {
        WakeMode::from_u8(self.mode.load(Ordering::Relaxed))
    }

    /// Takes effect at the next `hold`, which comes from the guard's own thread within seconds:
    /// on Windows the state belongs to that thread, so it is not applied from here.
    pub fn set_mode(&self, mode: WakeMode) {
        self.mode.store(mode.to_u8(), Ordering::Relaxed);
    }
}

impl SleepGuard for SystemSleepGuard {
    fn hold(&self, awake: bool) {
        let mode = self.mode();
        self.hold
            .set(awake && mode != WakeMode::Off, mode == WakeMode::Display);
    }
}

#[cfg(test)]
mod tests {
    use super::WakeMode;

    #[test]
    fn a_saved_mode_reads_back_and_anything_else_is_the_default() {
        for mode in [WakeMode::Off, WakeMode::System, WakeMode::Display] {
            assert_eq!(WakeMode::parse(mode.as_str()), mode);
            assert_eq!(WakeMode::from_u8(mode.to_u8()), mode);
        }
        assert_eq!(WakeMode::parse(""), WakeMode::Display);
        assert_eq!(WakeMode::parse("whatever"), WakeMode::Display);
    }
}
