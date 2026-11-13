use serde::{Deserialize, Serialize};

use super::agent::ProviderKind;
use super::ids::{RepositoryId, SessionId, WorkspaceId, WorktreeId};

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

/// What a session is for. Only `Chat` sessions are listed to the user; the others are
/// children of a chat (BTW investigations, decision discussions, artifact generation).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionKind {
    #[default]
    Chat,
    /// Read-only question or investigation.
    Btw,
    /// A change delegated by the user, with the usual permissions.
    Delegate,
    Decision,
    Analysis,
}

impl SessionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Btw => "btw",
            Self::Delegate => "delegate",
            Self::Decision => "decision",
            Self::Analysis => "analysis",
        }
    }

    /// Hidden sessions that only look and answer; they never write to the repository.
    pub fn read_only(self) -> bool {
        matches!(self, Self::Btw | Self::Decision | Self::Analysis)
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "chat" => Some(Self::Chat),
            "btw" => Some(Self::Btw),
            "delegate" => Some(Self::Delegate),
            "decision" => Some(Self::Decision),
            "analysis" => Some(Self::Analysis),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatSession {
    pub id: SessionId,
    /// The workspace the chat belongs to. Its agent sees every member repository.
    #[serde(default)]
    pub workspace_id: Option<WorkspaceId>,
    /// The chat's own repository and worktree: where its agent starts.
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
    #[serde(default)]
    pub kind: SessionKind,
    /// The chat this hidden session belongs to.
    #[serde(default)]
    pub parent_session_id: Option<SessionId>,
    pub created_at: String,
    pub updated_at: String,
    pub last_opened_at: Option<String>,
}
