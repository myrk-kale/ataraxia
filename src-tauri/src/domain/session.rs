use serde::{Deserialize, Serialize};

use super::agent::ProviderKind;
use super::ids::{RepositoryId, SessionId, WorktreeId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionStatus {
    Idle,
    Starting,
    Ready,
    Working,
    WaitingPermission,
    Stopping,
    Stopped,
    Failed,
}

impl SessionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Working => "working",
            Self::WaitingPermission => "waiting-permission",
            Self::Stopping => "stopping",
            Self::Stopped => "stopped",
            Self::Failed => "failed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "idle" => Some(Self::Idle),
            "starting" => Some(Self::Starting),
            "ready" => Some(Self::Ready),
            "working" => Some(Self::Working),
            "waiting-permission" => Some(Self::WaitingPermission),
            "stopping" => Some(Self::Stopping),
            "stopped" => Some(Self::Stopped),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatSession {
    pub id: SessionId,
    pub repository_id: RepositoryId,
    pub worktree_id: WorktreeId,
    pub provider: ProviderKind,
    pub title: String,
    pub status: SessionStatus,
    /// Model override for this chat; `None` lets the provider pick its default.
    #[serde(default)]
    pub model: Option<String>,
    /// Reasoning effort override; `None` keeps the provider's default.
    #[serde(default)]
    pub effort: Option<String>,
    /// Named agent the chat runs as (a Claude/OpenCode agent definition); `None` = default.
    #[serde(default)]
    pub agent: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub last_opened_at: Option<String>,
}
