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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatSession {
    pub id: SessionId,
    pub repository_id: RepositoryId,
    pub worktree_id: WorktreeId,
    pub provider: ProviderKind,
    pub title: String,
    pub status: SessionStatus,
}
