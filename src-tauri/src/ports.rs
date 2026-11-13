//! Side-effect ports. Application depends on these traits; adapters implement them.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::domain::agent::{CapabilityMatrix, ProviderDescriptor, ProviderKind, SessionOptions};
use crate::domain::ids::{
    CheckpointId, PtySessionId, RepositoryId, SessionId, TurnId, WorkspaceId, WorktreeId,
};
use crate::domain::{
    AgentEvent, ChatItem, ChatSession, ChatSnapshot, PermissionDecision, RepoInfo, Repository,
    Result, SessionStatus, Workspace, Worktree, WorktreeInfo,
};

/// What an agent process needs to reach Ataraxia's local API: the address and its own token.
#[derive(Clone, PartialEq, Eq)]
pub struct ApiAccess {
    pub url: String,
    pub token: String,
}

impl std::fmt::Debug for ApiAccess {
    // The token never reaches a log.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApiAccess")
            .field("url", &self.url)
            .field("token", &"<redacted>")
            .finish()
    }
}

/// Hands out the tokens agent processes use against the local API, one per process.
pub trait ApiGateway: Send + Sync {
    /// A fresh token bound to one chat session, read-write or read-only.
    fn issue(&self, session_id: SessionId, write: bool) -> ApiAccess;
    /// Makes a token stop working. Unknown tokens are ignored.
    fn revoke(&self, token: &str);
}

/// Uniform agent surface for Claude / Codex / OpenCode / fakes.
pub trait AgentRuntime: Send + Sync {
    fn providers(&self) -> Vec<ProviderDescriptor>;
    fn capabilities(&self, provider: ProviderKind) -> Result<CapabilityMatrix>;

    fn start_session(&self, session: &ChatSession) -> Result<()>;
    fn prompt(&self, session_id: &SessionId, text: &str) -> Result<TurnId>;
    fn cancel(&self, session_id: &SessionId, turn_id: Option<&TurnId>) -> Result<()>;
    fn resolve_permission(
        &self,
        session_id: &SessionId,
        decision: PermissionDecision,
    ) -> Result<()>;
    fn snapshot(&self, session_id: &SessionId) -> Result<ChatSnapshot>;
    /// Stores a new model/effort for the chat and applies it. Providers that cannot switch on a
    /// live process restart the session (the transcript stays, the agent starts fresh).
    fn configure_session(
        &self,
        session_id: &SessionId,
        model: Option<String>,
        effort: Option<String>,
        agent: Option<String>,
    ) -> Result<ChatSession>;
    /// Moves a chat to another harness. The transcript stays; the agent starts fresh.
    fn switch_provider(
        &self,
        session_id: &SessionId,
        provider: ProviderKind,
    ) -> Result<ChatSession>;
    /// Sends a message to one of the chat's subagents (shown in its own conversation).
    fn message_subagent(&self, session_id: &SessionId, subagent_id: &str, text: &str)
    -> Result<()>;
    /// Makes `child` (a BTW conversation) a subagent of `parent`: it is listed among the chat's
    /// subagents with its own conversation, which follows the child's events from now on. Runtimes
    /// without subagent lists leave this as it is.
    fn link_subagent(
        &self,
        child: &SessionId,
        parent: &SessionId,
        title: &str,
        question: &str,
    ) -> Result<()> {
        let _ = (child, parent, title, question);
        Ok(())
    }
    /// Ends the live agent process of a session, keeping its saved transcript.
    fn stop_session(&self, session_id: &SessionId);
    /// Models, efforts and agents the live session offers.
    fn session_options(&self, session_id: &SessionId) -> Result<SessionOptions>;
}

/// Outbound channel for agent events (Tauri `emit` in production, a recorder in tests).
pub trait EventSink: Send + Sync {
    fn emit_agent(&self, event: AgentEvent);
}

fn unsupported<T>(what: &str) -> Result<T> {
    Err(crate::domain::Error::new(
        crate::domain::ErrorCode::Unsupported,
        format!("{what} is not supported by this adapter"),
    ))
}

/// Outbound channel for derived-work changes (Tauri `emit` in production).
pub trait InsightSink: Send + Sync {
    fn emit_insight(&self, event: crate::domain::InsightEvent);
}

/// Everything the engine persists, behind one handle.
pub trait Database: Store + InsightStore {}
impl<T: Store + InsightStore> Database for T {}

/// Structure of source code, so changes can be attributed to functions and classes.
pub trait Syntax: Send + Sync {
    /// Name of the language when the file is one this parser knows.
    fn language_of(&self, path: &str) -> Option<&'static str>;
    /// Symbols of a file, outermost first; `None` for languages without a grammar.
    fn symbols(&self, path: &str, text: &str) -> Option<Vec<crate::domain::Symbol>>;
}

/// See [`Git::files_probe`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FilesProbe {
    /// `HEAD` as written, and the commit it resolves to when that can be told from the files.
    pub head: String,
    /// Size and modification time of the index.
    pub index: String,
}

pub trait Git: Send + Sync {
    fn discover(&self, path: &Path) -> Result<RepoInfo>;
    fn list_worktrees(&self, repo_root: &Path) -> Result<Vec<WorktreeInfo>>;

    /// What `HEAD` says right now (`ref: refs/heads/main`, or a commit id when detached), read
    /// without running git, so it is cheap enough to ask every second.
    fn head_marker(&self, _worktree: &Path) -> Result<String> {
        unsupported("head_marker")
    }

    /// What `HEAD` and the index look like right now, read without running git: the commit
    /// `HEAD` resolves to, and the size and time of the index file. Cheap enough to ask every
    /// second.
    fn files_probe(&self, _worktree: &Path) -> Result<FilesProbe> {
        unsupported("files_probe")
    }

    /// A fingerprint of the files of a worktree as git sees them: its `status` (tracked changes
    /// and untracked files) together with the size and time of every file listed. It costs one
    /// git process, so it is asked when the probe moved and now and then.
    fn status_stamp(&self, _worktree: &Path) -> Result<String> {
        unsupported("status_stamp")
    }

    /// Every local branch, newest first, with where each one is checked out.
    fn list_branches(&self, _worktree: &Path) -> Result<Vec<crate::domain::BranchInfo>> {
        unsupported("list_branches")
    }

    /// Checks a local branch out in `worktree`. Never forced: a dirty tree that would be
    /// overwritten, or a branch another worktree holds, is an error carrying git's own words.
    fn switch_branch(&self, _worktree: &Path, _name: &str) -> Result<()> {
        unsupported("switch_branch")
    }

    /// Commit id `HEAD` points at.
    fn head_rev(&self, _worktree: &Path) -> Result<String> {
        unsupported("head_rev")
    }

    /// Records the working tree (tracked and untracked, ignoring `.gitignore`d files) as a
    /// commit without touching the index, the branch or the files. The commit is kept alive
    /// under `refs/ataraxia/<keep>`.
    fn snapshot(&self, _worktree: &Path, _keep: &str) -> Result<String> {
        unsupported("snapshot")
    }

    /// Tree id of a revision, so two snapshots can be compared for equality.
    fn tree_id(&self, _worktree: &Path, _rev: &str) -> Result<String> {
        unsupported("tree_id")
    }

    fn changed_files(
        &self,
        _worktree: &Path,
        _base: &str,
        _head: &str,
    ) -> Result<Vec<crate::domain::ChangedFile>> {
        unsupported("changed_files")
    }

    /// Text of `path` at `rev`; `None` when it does not exist there or is binary.
    fn file_at(&self, _worktree: &Path, _rev: &str, _path: &str) -> Result<Option<String>> {
        unsupported("file_at")
    }

    /// Unified diff of one file between two revisions.
    fn diff_file(&self, _worktree: &Path, _base: &str, _head: &str, _path: &str) -> Result<String> {
        unsupported("diff_file")
    }

    /// Commit a user-typed revision (branch, tag, sha, `HEAD~2`...) points at.
    fn resolve_rev(&self, _worktree: &Path, _spec: &str) -> Result<String> {
        unsupported("resolve_rev")
    }

    fn merge_base(&self, _worktree: &Path, _a: &str, _b: &str) -> Result<String> {
        unsupported("merge_base")
    }

    /// Branches, tags and recent commits the diff can be taken against.
    fn list_refs(&self, _worktree: &Path) -> Result<crate::domain::GitRefs> {
        unsupported("list_refs")
    }

    /// One commit by branch, tag, abbreviated or full id.
    fn commit_info(&self, _worktree: &Path, _rev: &str) -> Result<crate::domain::CommitInfo> {
        unsupported("commit_info")
    }

    /// The newest commits that touched any of `paths`.
    fn commits_touching(
        &self,
        _worktree: &Path,
        _paths: &[String],
        _limit: usize,
    ) -> Result<Vec<crate::domain::CommitInfo>> {
        unsupported("commits_touching")
    }

    /// Where the change is in a file: the blocks of a zero-context diff.
    fn changed_ranges(
        &self,
        _worktree: &Path,
        _base: &str,
        _head: &str,
        _paths: &[String],
    ) -> Result<Vec<crate::domain::Hunk>> {
        unsupported("changed_ranges")
    }

    /// Files at `rev` that mention `name` as a whole word.
    fn files_mentioning(&self, _worktree: &Path, _rev: &str, _name: &str) -> Result<Vec<String>> {
        unsupported("files_mentioning")
    }

    /// Every file git knows about plus untracked ones that are not ignored, relative paths.
    fn list_files(&self, _worktree: &Path) -> Result<Vec<String>> {
        unsupported("list_files")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub text: String,
    pub binary: bool,
    pub too_large: bool,
    pub size: u64,
    /// Modification time in milliseconds; the guard for [`Fs::write_text`].
    pub mtime_ms: i64,
}

pub trait Fs: Send + Sync {
    fn exists(&self, path: &Path) -> Result<bool>;

    /// Reads a file inside `root`; paths that escape it are refused.
    fn read_text(&self, _root: &Path, _relative: &str) -> Result<FileContent> {
        unsupported("read_text")
    }

    /// Writes a file inside `root`. When `expected_mtime_ms` is set and the file changed since,
    /// nothing is written and a `Conflict` error is returned. Returns the new mtime.
    fn write_text(
        &self,
        _root: &Path,
        _relative: &str,
        _text: &str,
        _expected_mtime_ms: Option<i64>,
    ) -> Result<i64> {
        unsupported("write_text")
    }
}

pub trait Store: Send + Sync {
    fn health_check(&self) -> Result<()>;

    fn upsert_repository(&self, repo: &Repository) -> Result<()>;
    fn list_repositories(&self) -> Result<Vec<Repository>>;
    fn get_repository(&self, id: RepositoryId) -> Result<Option<Repository>>;
    fn find_repository_by_root(&self, root: &Path) -> Result<Option<Repository>>;

    fn upsert_worktree(&self, worktree: &Worktree) -> Result<()>;
    fn list_worktrees(&self, repository_id: RepositoryId) -> Result<Vec<Worktree>>;
    fn get_worktree(&self, id: WorktreeId) -> Result<Option<Worktree>>;
    fn find_worktree_by_path(
        &self,
        repository_id: RepositoryId,
        path: &Path,
    ) -> Result<Option<Worktree>>;

    fn upsert_workspace(&self, workspace: &Workspace) -> Result<()>;
    /// Every workspace, most recently changed first, each with its members in order.
    fn list_workspaces(&self) -> Result<Vec<Workspace>>;
    fn get_workspace(&self, id: WorkspaceId) -> Result<Option<Workspace>>;
    /// Removes the workspace and its membership. Chats are never deleted with it: the caller
    /// refuses to delete a workspace that still has some.
    fn delete_workspace(&self, id: WorkspaceId) -> Result<()>;
    /// The user's chats of a workspace, most recently opened first.
    fn list_workspace_sessions(&self, workspace_id: WorkspaceId) -> Result<Vec<ChatSession>>;
    /// Remembers the worktrees a chat sees besides its own.
    fn set_session_worktrees(&self, id: SessionId, worktrees: &[WorktreeId]) -> Result<()>;
    fn session_worktrees(&self, id: SessionId) -> Result<Vec<WorktreeId>>;

    fn create_session(&self, session: &ChatSession) -> Result<()>;
    fn list_sessions(&self, repository_id: RepositoryId) -> Result<Vec<ChatSession>>;
    fn get_session(&self, id: SessionId) -> Result<Option<ChatSession>>;
    fn touch_session(&self, id: SessionId, opened_at: &str) -> Result<()>;
    fn update_session_status(
        &self,
        id: SessionId,
        status: SessionStatus,
        updated_at: &str,
    ) -> Result<()>;
    fn update_session_settings(
        &self,
        id: SessionId,
        model: Option<&str>,
        effort: Option<&str>,
        agent: Option<&str>,
        updated_at: &str,
    ) -> Result<()>;
    /// Changes the harness of a chat; model, effort and agent reset with it.
    fn update_session_provider(
        &self,
        id: SessionId,
        provider: ProviderKind,
        updated_at: &str,
    ) -> Result<()>;

    /// Replaces the stored transcript of a session.
    fn replace_chat_items(&self, id: SessionId, items: &[ChatItem]) -> Result<()>;
    fn list_chat_items(&self, id: SessionId) -> Result<Vec<ChatItem>>;

    fn get_preference(&self, key: &str) -> Result<Option<String>>;
    fn set_preference(&self, key: &str, value: &str) -> Result<()>;
}

/// Persistence of everything derived from an agent's work.
pub trait InsightStore: Send + Sync {
    fn create_checkpoint(&self, checkpoint: &crate::domain::Checkpoint) -> Result<()>;
    fn update_checkpoint_status(
        &self,
        id: CheckpointId,
        status: crate::domain::ArtifactStatus,
    ) -> Result<()>;
    fn get_checkpoint(&self, id: CheckpointId) -> Result<Option<crate::domain::Checkpoint>>;
    /// Oldest first.
    fn list_checkpoints(&self, session_id: SessionId) -> Result<Vec<crate::domain::Checkpoint>>;
    /// Deletes every checkpoint of a chat, and with them everything that hangs off one: review
    /// queues, decisions and their threads, diagrams, marks, comments and set priorities.
    fn delete_session_checkpoints(&self, session_id: SessionId) -> Result<()>;
    fn latest_checkpoint(&self, session_id: SessionId)
    -> Result<Option<crate::domain::Checkpoint>>;

    /// Inserts the artifact, or returns the one that already exists for the same
    /// (checkpoint, kind, dedupe key); the bool tells whether it was created now.
    fn ensure_artifact(
        &self,
        artifact: &crate::domain::Artifact,
    ) -> Result<(crate::domain::Artifact, bool)>;
    fn update_artifact(
        &self,
        id: crate::domain::ArtifactId,
        status: crate::domain::ArtifactStatus,
        content: Option<&serde_json::Value>,
        provenance: Option<&serde_json::Value>,
        error: Option<&str>,
        updated_at: &str,
    ) -> Result<()>;
    fn get_artifact(
        &self,
        id: crate::domain::ArtifactId,
    ) -> Result<Option<crate::domain::Artifact>>;
    fn list_artifacts(
        &self,
        session_id: SessionId,
        kind: Option<crate::domain::ArtifactKind>,
    ) -> Result<Vec<crate::domain::Artifact>>;
    /// Marks the ready artifacts of `kind` older than `checkpoint` as stale.
    fn mark_artifacts_stale(
        &self,
        session_id: SessionId,
        kind: crate::domain::ArtifactKind,
        keep: CheckpointId,
        updated_at: &str,
    ) -> Result<usize>;
    /// Artifacts a previous run left `queued` or `running` (the app closed meanwhile).
    fn interrupted_artifacts(&self) -> Result<Vec<crate::domain::Artifact>>;

    fn insert_decision(&self, decision: &crate::domain::Decision) -> Result<()>;
    fn update_decision(&self, decision: &crate::domain::Decision, reason: &str) -> Result<()>;
    fn get_decision(
        &self,
        id: crate::domain::DecisionId,
    ) -> Result<Option<crate::domain::Decision>>;
    fn list_decisions(&self, session_id: SessionId) -> Result<Vec<crate::domain::Decision>>;
    fn set_unit_priority(&self, priority: &crate::domain::UnitPriority) -> Result<()>;
    fn clear_unit_priority(
        &self,
        checkpoint_id: crate::domain::ids::CheckpointId,
        path: &str,
        name: &str,
    ) -> Result<()>;
    fn list_unit_priorities(
        &self,
        checkpoint_id: crate::domain::ids::CheckpointId,
    ) -> Result<Vec<crate::domain::UnitPriority>>;
    fn add_decision_commit(&self, commit: &crate::domain::DecisionCommit) -> Result<()>;
    fn remove_decision_commit(&self, id: crate::domain::DecisionId, rev: &str) -> Result<()>;
    fn list_decision_commits(
        &self,
        id: crate::domain::DecisionId,
    ) -> Result<Vec<crate::domain::DecisionCommit>>;
    fn decision_revisions(
        &self,
        id: crate::domain::DecisionId,
    ) -> Result<Vec<crate::domain::DecisionRevision>>;
    fn add_decision_message(&self, message: &crate::domain::DecisionMessage) -> Result<()>;
    fn list_decision_messages(
        &self,
        id: crate::domain::DecisionId,
    ) -> Result<Vec<crate::domain::DecisionMessage>>;

    fn set_review_mark(&self, mark: &crate::domain::ReviewMark) -> Result<()>;
    fn list_review_marks(&self, id: CheckpointId) -> Result<Vec<crate::domain::ReviewMark>>;
    fn add_review_comment(&self, comment: &crate::domain::ReviewComment) -> Result<()>;
    fn list_review_comments(&self, id: CheckpointId) -> Result<Vec<crate::domain::ReviewComment>>;

    fn insert_btw_task(&self, task: &crate::domain::BtwTask) -> Result<()>;
    fn update_btw_task(
        &self,
        id: crate::domain::BtwTaskId,
        status: crate::domain::ArtifactStatus,
        summary: Option<&str>,
        returned_at: Option<&str>,
        updated_at: &str,
    ) -> Result<()>;
    fn get_btw_task(&self, id: crate::domain::BtwTaskId) -> Result<Option<crate::domain::BtwTask>>;
    fn btw_task_for_session(&self, session_id: SessionId)
    -> Result<Option<crate::domain::BtwTask>>;
    fn list_btw_tasks(&self, parent: SessionId) -> Result<Vec<crate::domain::BtwTask>>;

    fn list_flow_presets(
        &self,
        repository_id: RepositoryId,
    ) -> Result<Vec<crate::domain::FlowPreset>>;
    fn get_flow_preset(
        &self,
        id: crate::domain::FlowPresetId,
    ) -> Result<Option<crate::domain::FlowPreset>>;
    fn upsert_flow_preset(&self, preset: &crate::domain::FlowPreset) -> Result<()>;
    fn delete_flow_preset(&self, id: crate::domain::FlowPresetId) -> Result<()>;

    /// Hidden child sessions of a chat, newest first.
    fn list_child_sessions(&self, parent: SessionId) -> Result<Vec<crate::domain::ChatSession>>;
    fn replace_subagents(
        &self,
        session_id: SessionId,
        records: &[crate::domain::SubagentRecord],
    ) -> Result<()>;
    fn list_subagents(&self, session_id: SessionId) -> Result<Vec<crate::domain::SubagentRecord>>;

    fn audit_api(
        &self,
        at: &str,
        tool: &str,
        scope: Option<&str>,
        write: bool,
        ok: bool,
        detail: &str,
    ) -> Result<()>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawnRequest {
    pub worktree_id: WorktreeId,
    pub cwd: PathBuf,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyEnsureResponse {
    pub session_id: PtySessionId,
    pub created: bool,
    #[serde(with = "base64_bytes")]
    pub replay: Vec<u8>,
}

mod base64_bytes {
    use base64::Engine as _;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(bytes: &Vec<u8>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Vec<u8>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        base64::engine::general_purpose::STANDARD
            .decode(value)
            .map_err(serde::de::Error::custom)
    }
}

/// Native PTY host: one logical session per worktree.
pub trait PtyHost: Send + Sync {
    fn supported(&self) -> bool;
    fn ensure_session(&self, req: PtySpawnRequest) -> Result<PtyEnsureResponse>;
    fn write(&self, id: &PtySessionId, bytes: &[u8]) -> Result<()>;
    fn resize(&self, id: &PtySessionId, cols: u16, rows: u16) -> Result<()>;
    fn kill(&self, id: &PtySessionId) -> Result<()>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartSession {
    pub provider: ProviderKind,
    pub session_id: SessionId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prompt {
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartedTurn {
    pub turn_id: TurnId,
}
