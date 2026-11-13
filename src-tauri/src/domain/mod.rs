//! Pure domain types. No I/O.

pub mod agent;
pub mod chat;
pub mod error;
pub mod ids;
pub mod insight;
pub mod repo;
pub mod session;
pub mod time;

pub use chat::{
    AgentEvent, ChatItem, ChatMessage, ChatRole, ChatSnapshot, PendingPermission,
    PermissionDecision, PermissionRequestId, SubagentRecord, SubagentStatus, SubagentUpdate,
    ToolCallId, ToolCallRecord, ToolStatus,
};
pub use error::{Error, ErrorCode, Result};
pub use insight::{
    Alternative, Artifact, ArtifactId, ArtifactKind, ArtifactStatus, BtwMode, BtwTask, BtwTaskId,
    ChangedFile, Checkpoint, CheckpointSource, CodeRef, CommitInfo, Decision, DecisionCommit,
    DecisionId, DecisionKind, DecisionMessage, DecisionRevision, DecisionState, FileChange,
    FlowPreset, FlowPresetId, GitRefs, Hunk, InsightEvent, RefInfo, ReturnPolicy, ReviewComment,
    ReviewMark, ReviewState, RiskMarker, Symbol, UnitPriority,
};
pub use repo::{BranchInfo, RepoInfo, Repository, Workspace, Worktree, WorktreeInfo};
pub use session::{ChatSession, SessionKind, SessionStatus};
