use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use super::ids::{RepositoryId, WorktreeId};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Repository {
    pub id: RepositoryId,
    pub root: PathBuf,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Worktree {
    pub id: WorktreeId,
    pub repository_id: RepositoryId,
    pub path: PathBuf,
    pub branch: Option<String>,
    pub head: Option<String>,
}
