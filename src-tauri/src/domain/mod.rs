//! Pure domain types. No I/O.

pub mod agent;
pub mod chat;
pub mod error;
pub mod ids;
pub mod image;
pub mod insight;
pub mod profile;
pub mod queue;
pub mod repo;
pub mod session;
pub mod time;
pub mod usage;

pub use chat::{
    AgentEvent, ChatItem, ChatMessage, ChatRole, ChatSnapshot, ImageAttachment, ImageUpload,
    PendingPermission, PermissionDecision, PermissionRequestId, SubagentRecord, SubagentStatus,
    SubagentUpdate, ToolCallId, ToolCallRecord, ToolStatus,
};
pub use error::{Error, ErrorCode, Result};
pub use insight::{
    Alternative, Artifact, ArtifactId, ArtifactKind, ArtifactStatus, BtwMode, BtwTask, BtwTaskId,
    ChangedFile, Checkpoint, CheckpointSource, CodeRef, CommitInfo, Decision, DecisionCommit,
    DecisionId, DecisionKind, DecisionMessage, DecisionRevision, DecisionState, FileChange,
    FlowPreset, FlowPresetId, GitRefs, Hunk, InsightEvent, RefInfo, ReturnPolicy, ReviewComment,
    ReviewMark, ReviewState, RiskMarker, Symbol, UnitPriority,
};
pub use profile::{HarnessProfile, LaunchCommand, PROFILES_KEY, Profiles, parse_command};
pub use queue::{MessageQueue, QueuedMessage};
pub use repo::{BranchInfo, RepoInfo, Repository, Workspace, Worktree, WorktreeInfo};
pub use session::{ChatSession, SessionKind, SessionStatus};
pub use usage::{ProviderUsage, UsageWindow, UsageWindowKind};
