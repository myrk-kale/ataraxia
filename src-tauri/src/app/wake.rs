//! Keeps the machine awake while there is work the app has to see through.
//!
//! The operating system decides when to sleep from its own idle clock, which knows nothing about
//! agents. Here the app says when it is not idle: an agent working, a message waiting in a queue, a schedule that will fire, a wait for a usage limit to lift.
//! It counts every chat of every workspace, not only the one on screen.

use std::sync::{Arc, Weak};
use std::time::Duration;

use crate::domain::SessionStatus;
use crate::ports::SleepGuard;

use super::engine::Engine;

const TICK: Duration = Duration::from_secs(5);

impl Engine {
    /// Why the machine should stay awake right now, or `None` if nothing is pending.
    pub fn pending_work(&self) -> Option<&'static str> {
        let live = self.runtime.live_statuses().into_iter().any(|status| {
            matches!(
                status,
                SessionStatus::Starting
                    | SessionStatus::Working
                    | SessionStatus::WaitingPermission
                    | SessionStatus::Stopping
            )
        });
        if live {
            return Some("an agent is working");
        }
        // A schedule only fires while its chat's agent is alive, so an idle chat holds the
        // machine awake only if it has something scheduled.
        let schedule_pending = self.schedule_chats().into_iter().any(|id| {
            matches!(
                self.runtime.status(&id),
                Ok(SessionStatus::Ready
                    | SessionStatus::Working
                    | SessionStatus::WaitingPermission)
            )
        });
        if schedule_pending {
            return Some("a schedule is waiting to fire");
        }
        if !self.rate_waits.lock().is_empty() {
            return Some("waiting for a usage limit to lift");
        }
        if self
            .queues
            .lock()
            .values()
            .any(|queue| !queue.view().items.is_empty())
        {
            return Some("messages are queued");
        }
        if !self.busy.lock().is_empty() {
            return Some("a discussion is waiting for the agent");
        }
        None
    }

    /// Checks `pending_work` every few seconds and tells `guard`.
    pub fn start_sleep_guard(self: &Arc<Self>, guard: Arc<dyn SleepGuard>) {
        let engine: Weak<Engine> = Arc::downgrade(self);
        std::thread::spawn(move || {
            loop {
                let Some(engine) = engine.upgrade() else {
                    guard.hold(false);
                    return;
                };
                guard.hold(engine.pending_work().is_some());
                drop(engine);
                std::thread::sleep(TICK);
            }
        });
    }
}
