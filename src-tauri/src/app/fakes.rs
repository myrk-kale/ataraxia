//! Recording fakes for unit tests.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::domain::agent::{CapabilityMatrix, ProviderDescriptor, ProviderKind};
use crate::domain::ids::{RepositoryId, SessionId, WorktreeId};
use crate::domain::{
    ChatSession, Error, ErrorCode, RepoInfo, Repository, Result, Worktree, WorktreeInfo,
};
use crate::ports::{AgentRuntime, Fs, Git, PtyHost, Store};

#[derive(Debug, Default)]
pub struct FakeGit {
    pub calls: Mutex<Vec<String>>,
    pub repos: Mutex<HashMap<PathBuf, RepoInfo>>,
    pub worktrees: Mutex<HashMap<PathBuf, Vec<WorktreeInfo>>>,
}

impl FakeGit {
    pub fn with_repo(root: PathBuf, worktrees: Vec<WorktreeInfo>) -> Self {
        let name = root
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.display().to_string());
        let git = Self::default();
        git.repos.lock().expect("lock").insert(
            root.clone(),
            RepoInfo {
                root: root.clone(),
                name,
            },
        );
        git.worktrees.lock().expect("lock").insert(root, worktrees);
        git
    }
}

impl Git for FakeGit {
    fn discover(&self, path: &Path) -> Result<RepoInfo> {
        self.calls
            .lock()
            .expect("fake git lock")
            .push(format!("discover:{}", path.display()));
        let repos = self.repos.lock().expect("repos");
        repos
            .get(path)
            .cloned()
            .or_else(|| {
                repos.values().find_map(|repo| {
                    if path.starts_with(&repo.root) {
                        Some(repo.clone())
                    } else {
                        None
                    }
                })
            })
            .ok_or_else(|| Error::new(ErrorCode::NotARepo, "not a git repository"))
    }

    fn list_worktrees(&self, repo_root: &Path) -> Result<Vec<WorktreeInfo>> {
        self.calls
            .lock()
            .expect("fake git lock")
            .push(format!("list_worktrees:{}", repo_root.display()));
        self.worktrees
            .lock()
            .expect("worktrees")
            .get(repo_root)
            .cloned()
            .ok_or_else(|| Error::new(ErrorCode::NotARepo, "unknown repository"))
    }
}

#[derive(Debug, Default)]
pub struct FakeFs;

impl Fs for FakeFs {
    fn exists(&self, path: &Path) -> Result<bool> {
        Ok(path.exists())
    }
}

#[derive(Debug, Default)]
pub struct FakeStore {
    pub healthy: bool,
    repositories: Mutex<Vec<Repository>>,
    worktrees: Mutex<Vec<Worktree>>,
    sessions: Mutex<Vec<ChatSession>>,
    preferences: Mutex<HashMap<String, String>>,
}

impl Store for FakeStore {
    fn health_check(&self) -> Result<()> {
        if self.healthy {
            Ok(())
        } else {
            Err(Error::new(ErrorCode::Io, "store unavailable"))
        }
    }

    fn upsert_repository(&self, repo: &Repository) -> Result<()> {
        let mut repos = self.repositories.lock().expect("repos");
        if let Some(existing) = repos.iter_mut().find(|item| item.root == repo.root) {
            existing.name = repo.name.clone();
            existing.updated_at = repo.updated_at.clone();
        } else {
            repos.push(repo.clone());
        }
        Ok(())
    }

    fn list_repositories(&self) -> Result<Vec<Repository>> {
        Ok(self.repositories.lock().expect("repos").clone())
    }

    fn get_repository(&self, id: RepositoryId) -> Result<Option<Repository>> {
        Ok(self
            .repositories
            .lock()
            .expect("repos")
            .iter()
            .find(|item| item.id == id)
            .cloned())
    }

    fn find_repository_by_root(&self, root: &Path) -> Result<Option<Repository>> {
        Ok(self
            .repositories
            .lock()
            .expect("repos")
            .iter()
            .find(|item| item.root == root)
            .cloned())
    }

    fn upsert_worktree(&self, worktree: &Worktree) -> Result<()> {
        let mut worktrees = self.worktrees.lock().expect("worktrees");
        if let Some(existing) = worktrees
            .iter_mut()
            .find(|item| item.repository_id == worktree.repository_id && item.path == worktree.path)
        {
            existing.branch = worktree.branch.clone();
            existing.head = worktree.head.clone();
            existing.updated_at = worktree.updated_at.clone();
        } else {
            worktrees.push(worktree.clone());
        }
        Ok(())
    }

    fn list_worktrees(&self, repository_id: RepositoryId) -> Result<Vec<Worktree>> {
        Ok(self
            .worktrees
            .lock()
            .expect("worktrees")
            .iter()
            .filter(|item| item.repository_id == repository_id)
            .cloned()
            .collect())
    }

    fn get_worktree(&self, id: WorktreeId) -> Result<Option<Worktree>> {
        Ok(self
            .worktrees
            .lock()
            .expect("worktrees")
            .iter()
            .find(|item| item.id == id)
            .cloned())
    }

    fn find_worktree_by_path(
        &self,
        repository_id: RepositoryId,
        path: &Path,
    ) -> Result<Option<Worktree>> {
        Ok(self
            .worktrees
            .lock()
            .expect("worktrees")
            .iter()
            .find(|item| item.repository_id == repository_id && item.path == path)
            .cloned())
    }

    fn create_session(&self, session: &ChatSession) -> Result<()> {
        self.sessions
            .lock()
            .expect("sessions")
            .push(session.clone());
        Ok(())
    }

    fn list_sessions(&self, repository_id: RepositoryId) -> Result<Vec<ChatSession>> {
        Ok(self
            .sessions
            .lock()
            .expect("sessions")
            .iter()
            .filter(|item| item.repository_id == repository_id)
            .cloned()
            .collect())
    }

    fn get_session(&self, id: SessionId) -> Result<Option<ChatSession>> {
        Ok(self
            .sessions
            .lock()
            .expect("sessions")
            .iter()
            .find(|item| item.id == id)
            .cloned())
    }

    fn touch_session(&self, id: SessionId, opened_at: &str) -> Result<()> {
        let mut sessions = self.sessions.lock().expect("sessions");
        let session = sessions
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "session not found"))?;
        session.last_opened_at = Some(opened_at.to_string());
        session.updated_at = opened_at.to_string();
        Ok(())
    }

    fn get_preference(&self, key: &str) -> Result<Option<String>> {
        Ok(self.preferences.lock().expect("prefs").get(key).cloned())
    }

    fn set_preference(&self, key: &str, value: &str) -> Result<()> {
        self.preferences
            .lock()
            .expect("prefs")
            .insert(key.to_string(), value.to_string());
        Ok(())
    }
}

#[derive(Debug, Default)]
pub struct FakePty;

impl PtyHost for FakePty {
    fn supported(&self) -> bool {
        true
    }
}

#[derive(Debug, Default)]
pub struct FakeAgentRuntime;

impl AgentRuntime for FakeAgentRuntime {
    fn providers(&self) -> Vec<ProviderDescriptor> {
        vec![ProviderDescriptor {
            kind: ProviderKind::Fake,
            display_name: "Fake".into(),
            capabilities: CapabilityMatrix::fake(),
        }]
    }

    fn capabilities(&self, provider: ProviderKind) -> Result<CapabilityMatrix> {
        match provider {
            ProviderKind::Fake => Ok(CapabilityMatrix::fake()),
            other => Err(Error::new(
                ErrorCode::Unsupported,
                format!(
                    "provider {} is not registered in the fake runtime",
                    other.as_str()
                ),
            )),
        }
    }
}
