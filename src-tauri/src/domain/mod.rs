//! Pure domain types. No I/O.

pub mod agent;
pub mod chat;
pub mod error;
pub mod ids;
pub mod repo;
pub mod session;
pub mod time;

pub use chat::{
    AgentEvent, ChatItem, ChatMessage, ChatRole, ChatSnapshot, PendingPermission,
    PermissionDecision, PermissionRequestId, ToolCallId, ToolCallRecord, ToolStatus,
};
pub use error::{Error, ErrorCode, Result};
pub use repo::{RepoInfo, Repository, Worktree, WorktreeInfo};
pub use session::{ChatSession, SessionStatus};
