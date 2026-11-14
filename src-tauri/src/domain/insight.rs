//! Artifacts derived from an agent's work: checkpoints, decisions, review priorities, flows and
//! BTW investigations. Provenance: Repository -> Worktree -> Chat Session -> Checkpoint -> Artifact.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use super::ids::{CheckpointId, RepositoryId, SessionId, WorktreeId};

macro_rules! uuid_id {
    ($name:ident) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub Uuid);

        impl $name {
            pub fn new() -> Self {
                Self(Uuid::new_v4())
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }
    };
}

uuid_id!(ArtifactId);
uuid_id!(DecisionId);
uuid_id!(BtwTaskId);
uuid_id!(FlowPresetId);

/// Lifecycle of generated work, shared by checkpoints and artifacts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ArtifactStatus {
    Queued,
    Running,
    Ready,
    Failed,
    Stale,
}

impl ArtifactStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Ready => "ready",
            Self::Failed => "failed",
            Self::Stale => "stale",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "queued" => Some(Self::Queued),
            "running" => Some(Self::Running),
            "ready" => Some(Self::Ready),
            "failed" => Some(Self::Failed),
            "stale" => Some(Self::Stale),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    Decision,
    ReviewPriority,
    Flow,
}

impl ArtifactKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Decision => "decision",
            Self::ReviewPriority => "review_priority",
            Self::Flow => "flow",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "decision" => Some(Self::Decision),
            "review_priority" => Some(Self::ReviewPriority),
            "flow" => Some(Self::Flow),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FileChange {
    Added,
    Modified,
    Deleted,
    Renamed,
}

impl FileChange {
    pub fn from_status(letter: &str) -> Self {
        match letter.chars().next() {
            Some('A') => Self::Added,
            Some('D') => Self::Deleted,
            Some('R') | Some('C') => Self::Renamed,
            _ => Self::Modified,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangedFile {
    pub path: String,
    /// Previous path when the file was renamed.
    pub old_path: Option<String>,
    pub change: FileChange,
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CheckpointSource {
    /// Recorded when an agent turn finished.
    Turn,
    /// Recorded because the user asked for an artifact and none existed yet.
    Manual,
    /// Two revisions the user chose to compare: branches, commits or the working tree.
    Compare,
}

impl CheckpointSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Turn => "turn",
            Self::Manual => "manual",
            Self::Compare => "compare",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "turn" => Some(Self::Turn),
            "manual" => Some(Self::Manual),
            "compare" => Some(Self::Compare),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Checkpoint {
    pub id: CheckpointId,
    pub session_id: SessionId,
    pub repository_id: RepositoryId,
    pub worktree_id: WorktreeId,
    /// 1-based position inside the session.
    pub seq: u32,
    /// Snapshot commit of the working tree before the unit of work.
    pub base_rev: String,
    /// Snapshot commit of the working tree after it.
    pub head_rev: String,
    pub source: CheckpointSource,
    pub turn_id: Option<String>,
    pub files: Vec<ChangedFile>,
    pub status: ArtifactStatus,
    pub created_at: String,
    /// What the base side is called in the UI (`main`, `a1b2c3d`); `None` for turn checkpoints.
    #[serde(default)]
    pub base_label: Option<String>,
    #[serde(default)]
    pub head_label: Option<String>,
    /// The head is the live working tree, so its files can be edited.
    #[serde(default = "head_live_default")]
    pub head_live: bool,
}

fn head_live_default() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Artifact {
    pub id: ArtifactId,
    pub session_id: SessionId,
    pub checkpoint_id: CheckpointId,
    pub kind: ArtifactKind,
    pub dedupe_key: String,
    pub version: u32,
    pub status: ArtifactStatus,
    pub content: Value,
    /// How it was produced: generator, provider, prompt, preset and so on.
    pub provenance: Value,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DecisionKind {
    ApiContract,
    DataIntegrity,
    Behavior,
    Security,
    Dependencies,
    Performance,
    CodeOrganization,
    Ux,
    Other,
}

impl DecisionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ApiContract => "api-contract",
            Self::DataIntegrity => "data-integrity",
            Self::Behavior => "behavior",
            Self::Security => "security",
            Self::Dependencies => "dependencies",
            Self::Performance => "performance",
            Self::CodeOrganization => "code-organization",
            Self::Ux => "ux",
            Self::Other => "other",
        }
    }

    /// Unknown names fall back to `Other`, so a model's creative label never drops a decision.
    pub fn parse_lenient(value: &str) -> Self {
        match value
            .trim()
            .to_ascii_lowercase()
            .replace(['_', ' '], "-")
            .as_str()
        {
            "api-contract" | "api" | "contract" => Self::ApiContract,
            "data-integrity" | "data" => Self::DataIntegrity,
            "behavior" | "behaviour" => Self::Behavior,
            "security" => Self::Security,
            "dependencies" | "dependency" => Self::Dependencies,
            "performance" => Self::Performance,
            "code-organization" | "code-organisation" | "organization" => Self::CodeOrganization,
            "ux" => Self::Ux,
            _ => Self::Other,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DecisionState {
    Pending,
    Approved,
    Rejected,
    Superseded,
}

impl DecisionState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Rejected => "rejected",
            Self::Superseded => "superseded",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "approved" => Some(Self::Approved),
            "rejected" => Some(Self::Rejected),
            "superseded" => Some(Self::Superseded),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeRef {
    pub path: String,
    pub start_line: Option<u32>,
    pub end_line: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Alternative {
    pub title: String,
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Decision {
    pub id: DecisionId,
    pub session_id: SessionId,
    pub checkpoint_id: CheckpointId,
    pub artifact_id: Option<ArtifactId>,
    pub seq: u32,
    pub kind: DecisionKind,
    pub title: String,
    pub summary: String,
    pub context: String,
    pub rationale: String,
    pub alternatives: Vec<Alternative>,
    pub refs: Vec<CodeRef>,
    pub state: DecisionState,
    pub version: u32,
    pub superseded_by: Option<DecisionId>,
    /// Who opened the thread: `you`, `agent`, or the provider and model that generated it.
    #[serde(default)]
    pub opened_by: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecisionMessage {
    pub id: String,
    pub decision_id: DecisionId,
    /// `user` or `agent`.
    pub author: String,
    pub text: String,
    pub code_ref: Option<CodeRef>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecisionRevision {
    pub decision_id: DecisionId,
    pub version: u32,
    pub snapshot: Value,
    pub reason: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReviewState {
    Unreviewed,
    Viewed,
    Approved,
    ChangesRequested,
}

impl ReviewState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unreviewed => "unreviewed",
            Self::Viewed => "viewed",
            Self::Approved => "approved",
            Self::ChangesRequested => "changes-requested",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "unreviewed" => Some(Self::Unreviewed),
            "viewed" => Some(Self::Viewed),
            "approved" => Some(Self::Approved),
            "changes-requested" => Some(Self::ChangesRequested),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewMark {
    pub checkpoint_id: CheckpointId,
    pub path: String,
    pub state: ReviewState,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewComment {
    pub id: String,
    pub checkpoint_id: CheckpointId,
    pub path: String,
    pub line: Option<u32>,
    /// `base` or `head`.
    pub side: String,
    pub text: String,
    /// `you`, or `agent` when it was asked for in the chat or in BTW.
    #[serde(default = "you")]
    pub author: String,
    pub created_at: String,
}

fn you() -> String {
    "you".into()
}

/// A priority set on a unit of the review queue, on top of the one computed from the code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnitPriority {
    pub checkpoint_id: CheckpointId,
    pub path: String,
    /// Qualified name of the unit (`Repo.create`), or the path for a whole file.
    pub name: String,
    pub score: u32,
    pub reason: String,
    /// `you` or `agent`.
    pub set_by: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BtwMode {
    /// Read-only question or investigation.
    Ask,
    /// A delegated change, only after an explicit authorization.
    Change,
}

impl BtwMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Change => "change",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "ask" => Some(Self::Ask),
            "change" => Some(Self::Change),
            _ => None,
        }
    }
}

/// When a BTW result goes back to the main agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReturnPolicy {
    /// Only when the user sends it.
    Manual,
    /// Once a delegated change finishes (never for read-only questions).
    OnCompletion,
}

impl ReturnPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::OnCompletion => "on-completion",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "manual" => Some(Self::Manual),
            "on-completion" => Some(Self::OnCompletion),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BtwTask {
    pub id: BtwTaskId,
    pub parent_session_id: SessionId,
    /// The hidden conversation that runs the investigation.
    pub session_id: SessionId,
    pub mode: BtwMode,
    pub question: String,
    pub context: Value,
    /// Exactly the text that was attached to the question.
    pub context_text: String,
    pub return_policy: ReturnPolicy,
    pub summary: Option<String>,
    pub returned_at: Option<String>,
    pub status: ArtifactStatus,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FlowPreset {
    pub id: FlowPresetId,
    /// `None` = available in every repository.
    pub repository_id: Option<RepositoryId>,
    pub name: String,
    pub prompt: String,
    pub version: u32,
    pub builtin: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// Pushed to the UI when derived work changes, so it never has to poll.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum InsightEvent {
    #[serde(rename_all = "camelCase")]
    Checkpoint {
        session_id: SessionId,
        checkpoint_id: CheckpointId,
    },
    #[serde(rename_all = "camelCase")]
    Artifact {
        session_id: SessionId,
        artifact_id: ArtifactId,
        kind: ArtifactKind,
        status: ArtifactStatus,
    },
    #[serde(rename_all = "camelCase")]
    Decisions { session_id: SessionId },
    #[serde(rename_all = "camelCase")]
    DecisionThread { decision_id: DecisionId },
    #[serde(rename_all = "camelCase")]
    Btw {
        task_id: BtwTaskId,
        parent_session_id: SessionId,
        status: ArtifactStatus,
    },
    /// Everything derived for a chat was deleted.
    #[serde(rename_all = "camelCase")]
    Cleared { session_id: SessionId },
    /// The messages a chat has waiting changed.
    #[serde(rename_all = "camelCase")]
    Queue {
        session_id: SessionId,
        queue: crate::domain::MessageQueue,
    },
}

/// A named piece of code found by a parser: the unit a change is attributed to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Symbol {
    pub name: String,
    /// `Class.method`, `impl.method`, `module.function`...
    pub qualified: String,
    /// `function`, `method`, `class`, `struct`, `enum`, `trait`, `interface`, `impl`, `module`,
    /// `type`, `const`.
    pub kind: String,
    /// 1-based, inclusive.
    pub start_line: u32,
    pub end_line: u32,
    /// The declaration up to its body, whitespace collapsed: what callers depend on.
    pub signature: String,
    pub public: bool,
    /// Qualified name of the enclosing class, impl, trait or module.
    pub container: Option<String>,
    /// Cyclomatic complexity of the body (1 plus its branches); 0 for containers.
    #[serde(default)]
    pub complexity: u32,
    /// Hash of the code's tokens without comments or whitespace: equal on both sides means a
    /// change that only moved formatting or comments.
    #[serde(default)]
    pub fingerprint: u64,
    /// Risky constructs found in the body.
    #[serde(default)]
    pub markers: Vec<RiskMarker>,
    /// Decorators, attributes and annotations attached to it (`#[tauri::command]`, `@app.route`).
    #[serde(default)]
    pub attributes: Vec<String>,
}

/// A construct a reviewer should look at twice. A pointer for a human, never a verdict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RiskMarker {
    /// `sql_from_dynamic_text`, `secret_literal`, `dynamic_execution`, `shell_execution`,
    /// `verification_disabled`, `unsafe_block`, `swallowed_error` or `io_in_loop`.
    pub rule: String,
    /// 1-based line of the construct.
    pub line: u32,
}

/// One block of a zero-context diff: 1-based start and length on each side.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hunk {
    pub old_start: u32,
    pub old_len: u32,
    pub new_start: u32,
    pub new_len: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RefInfo {
    /// Short name: `main`, `origin/main`, `v1.2`.
    pub name: String,
    /// `branch`, `remote` or `tag`.
    pub kind: String,
    pub rev: String,
    pub subject: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitInfo {
    pub rev: String,
    pub short: String,
    pub subject: String,
    pub date: String,
    #[serde(default)]
    pub author: String,
}

/// A commit that influences a decision, and who said so.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecisionCommit {
    pub decision_id: DecisionId,
    pub rev: String,
    pub short: String,
    pub subject: String,
    pub author: String,
    pub committed_at: String,
    /// What the commit changed about the decision, in the linker's words.
    pub note: String,
    /// `user` or `agent`.
    pub linked_by: String,
    pub created_at: String,
}

/// What a diff can be taken against.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitRefs {
    /// The checked-out branch, `None` when detached.
    pub current: Option<String>,
    pub refs: Vec<RefInfo>,
    /// Most recent commits of the checked-out history.
    pub commits: Vec<CommitInfo>,
}
