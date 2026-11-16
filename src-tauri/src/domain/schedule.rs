//! Things the agent asked to be told about later: "check the release again in ten minutes".
//!
//! The schedule belongs to the chat, not to the agent process, so it survives the app restarting,
//! the agent being swapped for another harness and the process dying. It is the same for every
//! agent: they all create one through the local API.

use serde::{Deserialize, Serialize};

/// One reminder: at `next_run` the chat is sent `prompt`, as a message marked as scheduled.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Schedule {
    pub id: String,
    pub prompt: String,
    /// When it fires next, in seconds since the Unix epoch.
    pub next_run: i64,
    /// Seconds between runs; `None` runs once.
    #[serde(default)]
    pub every_secs: Option<i64>,
    /// A recurring schedule stops by itself after this moment (seconds since the Unix epoch).
    #[serde(default)]
    pub expires_at: Option<i64>,
    pub created_at: i64,
}

/// The start of every message a schedule sends, which is how the agent and the screen tell it
/// from something the user typed.
pub const SCHEDULED_PREFIX: &str = "[Scheduled task ";

impl Schedule {
    /// The message that goes to the agent when this schedule fires.
    pub fn message(&self) -> String {
        format!(
            "{SCHEDULED_PREFIX}{}] {}",
            self.short_id(),
            self.prompt.trim()
        )
    }

    pub fn short_id(&self) -> &str {
        self.id.get(..8).unwrap_or(&self.id)
    }
}
