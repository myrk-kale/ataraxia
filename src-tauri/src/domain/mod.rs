//! Pure domain types. No I/O.

pub mod agent;
pub mod browser;
pub mod chat;
pub mod error;
pub mod ids;
pub mod image;
pub mod insight;
pub mod memory;
pub mod profile;
pub mod queue;
pub mod repo;
pub mod schedule;
pub mod session;
pub mod task;
pub mod time;
pub mod usage;

pub use chat::{
    AgentEvent, ChatItem, ChatMessage, ChatRole, ChatSnapshot, ImageAttachment, ImageUpload,
    PendingPermission, PermissionDecision, PermissionQuestion, PermissionRequestId, QuestionOption,
    SubagentRecord, SubagentStatus, SubagentUpdate, ToolCallId, ToolCallRecord, ToolStatus,
};
pub use error::{Error, ErrorCode, Result};
pub use insight::{
    Alternative, Artifact, ArtifactId, ArtifactKind, ArtifactStatus, BtwMode, BtwTask, BtwTaskId,
    ChangedFile, Checkpoint, CheckpointSource, CodeRef, CommitInfo, Decision, DecisionCommit,
    DecisionId, DecisionKind, DecisionMessage, DecisionRevision, DecisionState, FileChange,
    FlowPreset, FlowPresetId, GitRefs, Hunk, InsightEvent, RefInfo, ReturnPolicy, ReviewComment,
    ReviewMark, ReviewState, RiskMarker, Symbol, UnitPriority,
};
pub use memory::{Memory, MemoryAuthor, MemoryKind, MemoryLink, MemorySource, Relation};
pub use profile::{HarnessProfile, LaunchCommand, PROFILES_KEY, Profiles, parse_command};
pub use queue::{MessageQueue, QueuedMessage};
pub use repo::{BranchInfo, RepoInfo, Repository, Workspace, Worktree, WorktreeInfo};
pub use schedule::{SCHEDULED_PREFIX, Schedule};
pub use session::{ChatSession, SessionKind, SessionStatus};
pub use task::{Task, TaskPatch, TaskStatus};
pub use usage::{ProviderUsage, UsageWindow, UsageWindowKind};
