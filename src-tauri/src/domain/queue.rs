//! Messages typed while the agent is still working, sent one after another when it is done.

use serde::{Deserialize, Serialize};

/// One message waiting for its turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueuedMessage {
    pub id: String,
    pub text: String,
    /// The names of the pictures that go with it (the pictures stay in the app).
    #[serde(default)]
    pub images: Vec<String>,
}

/// What a chat has waiting, in the order it will be sent.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageQueue {
    pub items: Vec<QueuedMessage>,
    /// The turn before it was stopped or failed, so nothing goes out until the user says so.
    pub paused: bool,
}
