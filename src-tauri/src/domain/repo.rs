use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use super::ids::{RepositoryId, WorktreeId};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Repository {
    pub id: RepositoryId,
    pub root: PathBuf,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Worktree {
    pub id: WorktreeId,
    pub repository_id: RepositoryId,
    pub path: PathBuf,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoInfo {
    pub root: PathBuf,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreeInfo {
    pub path: PathBuf,
    pub branch: Option<String>,
    pub head: Option<String>,
}

/// A local branch, and where it is checked out, if anywhere.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BranchInfo {
    pub name: String,
    /// It is the branch the asked worktree has checked out.
    pub current: bool,
    /// Another worktree has it checked out (git will not check it out a second time).
    pub worktree_path: Option<PathBuf>,
}
