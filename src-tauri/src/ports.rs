//! Side-effect ports. Application depends on these traits; adapters implement them.

use std::path::Path;

use crate::domain::agent::{CapabilityMatrix, ProviderDescriptor, ProviderKind};
use crate::domain::ids::{RepositoryId, SessionId, TurnId, WorktreeId};
use crate::domain::{ChatSession, RepoInfo, Repository, Result, Worktree, WorktreeInfo};

/// Uniform agent surface for Claude / Codex / OpenCode / fakes.
pub trait AgentRuntime: Send + Sync {
    fn providers(&self) -> Vec<ProviderDescriptor>;
    fn capabilities(&self, provider: ProviderKind) -> Result<CapabilityMatrix>;
}

pub trait Git: Send + Sync {
    fn discover(&self, path: &Path) -> Result<RepoInfo>;
    fn list_worktrees(&self, repo_root: &Path) -> Result<Vec<WorktreeInfo>>;
}

pub trait Fs: Send + Sync {
    fn exists(&self, path: &Path) -> Result<bool>;
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

    fn create_session(&self, session: &ChatSession) -> Result<()>;
    fn list_sessions(&self, repository_id: RepositoryId) -> Result<Vec<ChatSession>>;
    fn get_session(&self, id: SessionId) -> Result<Option<ChatSession>>;
    fn touch_session(&self, id: SessionId, opened_at: &str) -> Result<()>;

    fn get_preference(&self, key: &str) -> Result<Option<String>>;
    fn set_preference(&self, key: &str, value: &str) -> Result<()>;
}

/// Placeholder PTY port.
pub trait PtyHost: Send + Sync {
    fn supported(&self) -> bool;
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
