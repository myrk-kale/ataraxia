//! Keeping the machine awake, per platform.
//!
//! macOS holds an IOKit assertion. Linux holds a systemd inhibitor process. Windows sets
//! the execution state of the calling thread.

use crate::ports::SleepGuard;

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

    struct Assertion(u32);

    impl Assertion {
        fn acquire() -> Result<Self, i32> {
            // This assertion applies on battery and AC and lets the display sleep.
            let kind = CFString::new("PreventUserIdleSystemSleep");
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
                Ok(Self(id))
            } else {
                Err(result)
            }
        }
    }

    impl Drop for Assertion {
        fn drop(&mut self) {
            // SAFETY: This ID came from a successful acquisition and is released once.
            let result = unsafe { IOPMAssertionRelease(self.0) };
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
        pub fn set(&self, awake: bool) {
            let mut assertion = self.assertion.lock();
            if !awake {
                *assertion = None;
            } else if assertion.is_none() {
                match Assertion::acquire() {
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
        child: Mutex<Option<Child>>,
    }

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
