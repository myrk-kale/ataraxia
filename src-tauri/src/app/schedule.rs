//! What the agent asked to be woken up for: a check on a release, a retry in ten minutes.
//!
//! The same for every agent, because the app keeps it and the agents only ask for it through the
//! local API. When the time comes the message goes through the chat's own queue, so it waits for
//! the agent to be free, goes out one at a time and holds when a turn was stopped.
//!
//! A schedule that falls due while its agent is not running (the app was closed, the chat not
//! opened yet) is not replayed once per missed run: it fires once, when the agent is back.

use std::sync::{Arc, Weak};
use std::time::Duration;

use time::OffsetDateTime;

use crate::domain::ids::SessionId;
use crate::domain::{
    Error, ErrorCode, InsightEvent, Result, SCHEDULED_PREFIX, Schedule, SessionKind, SessionStatus,
};

use super::engine::Engine;

/// The shortest wait or interval: the agent is not a clock to the second.
pub const MIN_SECS: i64 = 60;
/// The furthest ahead something can be scheduled.
pub const MAX_AHEAD_SECS: i64 = 7 * 24 * 3600;
/// A recurring schedule stops by itself after this long, so a forgotten one does not run forever.
pub const RECURRING_LIFETIME_SECS: i64 = 7 * 24 * 3600;
/// How many schedules one chat may hold.
pub const MAX_PER_CHAT: usize = 20;
/// How often the scheduler looks for what is due.
const TICK: Duration = Duration::from_secs(5);

/// Which chats have schedules, so the scheduler does not scan them all.
const INDEX_KEY: &str = "schedules:chats";

fn key(session_id: SessionId) -> String {
    format!("schedules:{}", session_id.0)
}

pub fn unix_now() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}

impl Engine {
    /// What a chat has scheduled, soonest first.
    pub fn schedules(&self, session_id: SessionId) -> Vec<Schedule> {
        let mut items = self.schedules_read(session_id);
        items.sort_by_key(|item| item.next_run);
        items
    }

    /// Schedules `prompt` to be sent to the chat `delay_secs` from now, and then every
    /// `every_secs` if given.
    pub fn schedule_add(
        &self,
        session_id: SessionId,
        prompt: &str,
        delay_secs: i64,
        every_secs: Option<i64>,
    ) -> Result<Schedule> {
        let prompt = prompt.trim();
        if prompt.is_empty() {
            return Err(Error::new(ErrorCode::Invalid, "`prompt` is empty"));
        }
        if self.session(session_id)?.kind != SessionKind::Chat {
            return Err(Error::new(
                ErrorCode::Invalid,
                "only chats can schedule messages",
            ));
        }
        if !(MIN_SECS..=MAX_AHEAD_SECS).contains(&delay_secs) {
            return Err(Error::new(
                ErrorCode::Invalid,
                format!(
                    "the first run must be between {} minute and {} days from now",
                    MIN_SECS / 60,
                    MAX_AHEAD_SECS / 86_400
                ),
            ));
        }
        if let Some(every) = every_secs {
            if !(MIN_SECS..=MAX_AHEAD_SECS).contains(&every) {
                return Err(Error::new(
                    ErrorCode::Invalid,
                    format!(
                        "the interval must be between {} minute and {} days",
                        MIN_SECS / 60,
                        MAX_AHEAD_SECS / 86_400
                    ),
                ));
            }
        }
        let now = unix_now();
        let schedule = Schedule {
            id: uuid::Uuid::new_v4().to_string(),
            prompt: prompt.to_string(),
            next_run: now + delay_secs,
            every_secs,
            expires_at: every_secs.map(|_| now + RECURRING_LIFETIME_SECS),
            created_at: now,
        };
        let items = {
            let _held = self.schedule_lock.lock();
            let mut items = self.schedules_read(session_id);
            if items.len() >= MAX_PER_CHAT {
                return Err(Error::new(
                    ErrorCode::Invalid,
                    format!("a chat may hold {MAX_PER_CHAT} schedules; cancel one first"),
                ));
            }
            items.push(schedule.clone());
            self.schedules_write(session_id, &items)?;
            items
        };
        self.emit_schedules(session_id, items);
        Ok(schedule)
    }

    /// Cancels a schedule by its id, or by the first characters of it.
    pub fn schedule_cancel(&self, session_id: SessionId, id: &str) -> Result<Vec<Schedule>> {
        let id = id.trim();
        let items = {
            let _held = self.schedule_lock.lock();
            let mut items = self.schedules_read(session_id);
            let matching: Vec<usize> = items
                .iter()
                .enumerate()
                .filter(|(_, item)| !id.is_empty() && item.id.starts_with(id))
                .map(|(index, _)| index)
                .collect();
            match matching.as_slice() {
                [index] => {
                    items.remove(*index);
                }
                [] => return Err(Error::new(ErrorCode::NotFound, "no such schedule")),
                _ => {
                    return Err(Error::new(
                        ErrorCode::Invalid,
                        "that id matches more than one schedule",
                    ));
                }
            }
            self.schedules_write(session_id, &items)?;
            items
        };
        self.emit_schedules(session_id, items.clone());
        Ok(items)
    }

    /// Starts the clock: from now on what falls due is sent to its chat.
    pub fn start_scheduler(self: &Arc<Self>) {
        let engine: Weak<Engine> = Arc::downgrade(self);
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(TICK);
                let Some(engine) = engine.upgrade() else {
                    return;
                };
                engine.schedules_tick(unix_now());
            }
        });
    }

    /// Sends what fell due by `now`. A recurring schedule is set to run again `every_secs` from
    /// now (never several times to catch up), a one-off is dropped, an expired one is dropped
    /// without running.
    pub(crate) fn schedules_tick(&self, now: i64) {
        for session_id in self.schedule_chats() {
            self.schedules_tick_chat(session_id, now);
        }
    }

    fn schedules_tick_chat(&self, session_id: SessionId, now: i64) {
        // A chat that was deleted takes its schedules with it.
        if matches!(self.session(session_id), Err(ref error) if error.code == ErrorCode::NotFound) {
            let _held = self.schedule_lock.lock();
            let _ = self.schedules_write(session_id, &[]);
            return;
        }
        // Not running: it fires once it is, instead of failing now and pausing the queue.
        let live = matches!(
            self.runtime.status(&session_id),
            Ok(SessionStatus::Ready | SessionStatus::Working | SessionStatus::WaitingPermission)
        );
        if !live {
            return;
        }
        let (fire, items) = {
            let _held = self.schedule_lock.lock();
            let mut items = self.schedules_read(session_id);
            if !items.iter().any(|item| item.next_run <= now) {
                return;
            }
            let mut fire = Vec::new();
            items.retain_mut(|item| {
                if item.next_run > now {
                    return true;
                }
                if item.expires_at.is_some_and(|limit| limit <= now) {
                    return false;
                }
                fire.push(item.clone());
                match item.every_secs {
                    Some(every) => {
                        item.next_run = now + every;
                        true
                    }
                    None => false,
                }
            });
            if self.schedules_write(session_id, &items).is_err() {
                // Not saved, so not sent: the next tick tries again rather than sending twice.
                return;
            }
            (fire, items)
        };
        self.emit_schedules(session_id, items);
        for schedule in fire {
            // A recurring one still waiting in the queue is not stacked up behind itself.
            if self.queue_holds(session_id, &schedule.message()) {
                continue;
            }
            if let Err(error) = self.enqueue(session_id, &schedule.message(), Vec::new()) {
                eprintln!("ataraxia: could not send a scheduled message: {error}");
            }
        }
    }

    fn queue_holds(&self, session_id: SessionId, text: &str) -> bool {
        self.queue(session_id)
            .items
            .iter()
            .any(|item| item.text == text)
    }

    fn schedules_read(&self, session_id: SessionId) -> Vec<Schedule> {
        self.db
            .get_preference(&key(session_id))
            .ok()
            .flatten()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn schedules_write(&self, session_id: SessionId, items: &[Schedule]) -> Result<()> {
        let text = serde_json::to_string(items)
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
        self.db.set_preference(&key(session_id), &text)?;
        let mut chats = self.schedule_chats();
        let listed = chats.contains(&session_id);
        if items.is_empty() && listed {
            chats.retain(|chat| *chat != session_id);
        } else if !items.is_empty() && !listed {
            chats.push(session_id);
        } else {
            return Ok(());
        }
        let text = serde_json::to_string(&chats)
            .map_err(|error| Error::new(ErrorCode::Io, error.to_string()))?;
        self.db.set_preference(INDEX_KEY, &text)
    }

    fn schedule_chats(&self) -> Vec<SessionId> {
        self.db
            .get_preference(INDEX_KEY)
            .ok()
            .flatten()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn emit_schedules(&self, session_id: SessionId, mut schedules: Vec<Schedule>) {
        schedules.sort_by_key(|item| item.next_run);
        self.sink.emit_insight(InsightEvent::Schedules {
            session_id,
            schedules,
        });
    }
}

/// Whether a message was sent by a schedule rather than typed.
pub fn is_scheduled_message(text: &str) -> bool {
    text.starts_with(SCHEDULED_PREFIX)
}

impl crate::api::Scheduling for Engine {
    fn list(&self, session: SessionId) -> Vec<Schedule> {
        self.schedules(session)
    }

    fn add(
        &self,
        session: SessionId,
        prompt: &str,
        delay_secs: i64,
        every_secs: Option<i64>,
    ) -> Result<Schedule> {
        self.schedule_add(session, prompt, delay_secs, every_secs)
    }

    fn cancel(&self, session: SessionId, id: &str) -> Result<()> {
        self.schedule_cancel(session, id).map(|_| ())
    }
}
