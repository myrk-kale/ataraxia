//! Workspace use-cases: repositories, worktrees, chat sessions.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::domain::agent::ProviderKind;
use crate::domain::ids::{RepositoryId, SessionId, WorktreeId};
use crate::domain::time::now_rfc3339;
use crate::domain::{ChatSession, Error, ErrorCode, Repository, Result, SessionStatus, Worktree};
use crate::ports::{Git, Store};

const PREF_SELECTED_REPO: &str = "selected_repository_id";
const PREF_SELECTED_WORKTREE: &str = "selected_worktree_id";
const PREF_SELECTED_SESSION: &str = "selected_session_id";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceSnapshot {
    pub repositories: Vec<Repository>,
    pub selected_repository_id: Option<RepositoryId>,
    pub worktrees: Vec<Worktree>,
    pub selected_worktree_id: Option<WorktreeId>,
    pub sessions: Vec<ChatSession>,
    pub selected_session_id: Option<SessionId>,
}

pub struct WorkspaceService<'a> {
    pub git: &'a dyn Git,
    pub store: &'a dyn Store,
}

impl<'a> WorkspaceService<'a> {
    pub fn bootstrap(&self) -> Result<WorkspaceSnapshot> {
        let repositories = self.store.list_repositories()?;
        let selected_repository_id = self.preference_id(PREF_SELECTED_REPO)?.and_then(|id| {
            repositories
                .iter()
                .find(|repo| repo.id.0.to_string() == id)
                .map(|repo| repo.id)
        });
        let selected_repository_id =
            selected_repository_id.or_else(|| repositories.first().map(|repo| repo.id));

        let (worktrees, sessions, selected_worktree_id, selected_session_id) =
            if let Some(repository_id) = selected_repository_id {
                let worktrees = self.store.list_worktrees(repository_id)?;
                let sessions = self.store.list_sessions(repository_id)?;
                let selected_worktree_id = self
                    .preference_id(PREF_SELECTED_WORKTREE)?
                    .and_then(|id| {
                        worktrees
                            .iter()
                            .find(|item| item.id.0.to_string() == id)
                            .map(|item| item.id)
                    })
                    .or_else(|| worktrees.first().map(|item| item.id));
                let selected_session_id =
                    self.preference_id(PREF_SELECTED_SESSION)?.and_then(|id| {
                        sessions
                            .iter()
                            .find(|item| item.id.0.to_string() == id)
                            .map(|item| item.id)
                    });
                (
                    worktrees,
                    sessions,
                    selected_worktree_id,
                    selected_session_id,
                )
            } else {
                (Vec::new(), Vec::new(), None, None)
            };

        Ok(WorkspaceSnapshot {
            repositories,
            selected_repository_id,
            worktrees,
            selected_worktree_id,
            sessions,
            selected_session_id,
        })
    }

    pub fn open_repository(&self, path: impl AsRef<Path>) -> Result<WorkspaceSnapshot> {
        let path = path.as_ref();
        let info = self.git.discover(path).map_err(|error| {
            if error.code == ErrorCode::Io || error.code == ErrorCode::NotARepo {
                Error::new(ErrorCode::NotARepo, error.message)
            } else {
                error
            }
        })?;
        let now = now_rfc3339()?;
        let existing = self.store.find_repository_by_root(&info.root)?;
        let repository = if let Some(existing) = existing {
            let mut updated = existing;
            updated.name = info.name;
            updated.updated_at = now.clone();
            self.store.upsert_repository(&updated)?;
            updated
        } else {
            let repository = Repository {
                id: RepositoryId::new(),
                root: info.root.clone(),
                name: info.name,
                created_at: now.clone(),
                updated_at: now.clone(),
            };
            self.store.upsert_repository(&repository)?;
            repository
        };

        self.sync_worktrees(repository.id, &repository.root, &now)?;
        self.store
            .set_preference(PREF_SELECTED_REPO, &repository.id.0.to_string())?;

        let worktrees = self.store.list_worktrees(repository.id)?;
        let selected_worktree_id = worktrees
            .iter()
            .find(|item| item.path == info.root)
            .map(|item| item.id)
            .or_else(|| worktrees.first().map(|item| item.id));
        if let Some(worktree_id) = selected_worktree_id {
            self.store
                .set_preference(PREF_SELECTED_WORKTREE, &worktree_id.0.to_string())?;
        }

        self.bootstrap()
    }

    pub fn select_repository(&self, repository_id: RepositoryId) -> Result<WorkspaceSnapshot> {
        let repository = self
            .store
            .get_repository(repository_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "repository not found"))?;
        let now = now_rfc3339()?;
        let _ = self.sync_worktrees(repository.id, &repository.root, &now);
        self.store
            .set_preference(PREF_SELECTED_REPO, &repository.id.0.to_string())?;
        let worktrees = self.store.list_worktrees(repository.id)?;
        if let Some(worktree) = worktrees.first() {
            self.store
                .set_preference(PREF_SELECTED_WORKTREE, &worktree.id.0.to_string())?;
        }
        self.store.set_preference(PREF_SELECTED_SESSION, "")?;
        self.bootstrap()
    }

    pub fn select_worktree(&self, worktree_id: WorktreeId) -> Result<WorkspaceSnapshot> {
        let worktree = self
            .store
            .get_worktree(worktree_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "worktree not found"))?;
        self.store
            .set_preference(PREF_SELECTED_REPO, &worktree.repository_id.0.to_string())?;
        self.store
            .set_preference(PREF_SELECTED_WORKTREE, &worktree.id.0.to_string())?;
        self.bootstrap()
    }

    pub fn create_session(
        &self,
        repository_id: RepositoryId,
        worktree_id: WorktreeId,
        title: Option<String>,
        provider: ProviderKind,
    ) -> Result<WorkspaceSnapshot> {
        let repository = self
            .store
            .get_repository(repository_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "repository not found"))?;
        let worktree = self
            .store
            .get_worktree(worktree_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "worktree not found"))?;
        if worktree.repository_id != repository.id {
            return Err(Error::new(
                ErrorCode::Invalid,
                "worktree does not belong to repository",
            ));
        }

        let now = now_rfc3339()?;
        let count = self.store.list_sessions(repository.id)?.len() + 1;
        let session = ChatSession {
            id: SessionId::new(),
            repository_id: repository.id,
            worktree_id: worktree.id,
            provider,
            title: title
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| format!("Chat {count}")),
            status: SessionStatus::Idle,
            model: None,
            effort: None,
            agent: None,
            created_at: now.clone(),
            updated_at: now.clone(),
            last_opened_at: Some(now.clone()),
        };
        self.store.create_session(&session)?;
        self.store
            .set_preference(PREF_SELECTED_REPO, &repository.id.0.to_string())?;
        self.store
            .set_preference(PREF_SELECTED_WORKTREE, &worktree.id.0.to_string())?;
        self.store
            .set_preference(PREF_SELECTED_SESSION, &session.id.0.to_string())?;
        self.bootstrap()
    }

    pub fn open_session(&self, session_id: SessionId) -> Result<WorkspaceSnapshot> {
        let session = self
            .store
            .get_session(session_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "session not found"))?;
        let now = now_rfc3339()?;
        self.store.touch_session(session.id, &now)?;
        self.store
            .set_preference(PREF_SELECTED_REPO, &session.repository_id.0.to_string())?;
        self.store
            .set_preference(PREF_SELECTED_WORKTREE, &session.worktree_id.0.to_string())?;
        self.store
            .set_preference(PREF_SELECTED_SESSION, &session.id.0.to_string())?;
        self.bootstrap()
    }

    fn sync_worktrees(
        &self,
        repository_id: RepositoryId,
        repo_root: &Path,
        now: &str,
    ) -> Result<Vec<Worktree>> {
        let discovered = self.git.list_worktrees(repo_root)?;
        for info in discovered {
            if let Some(mut existing) = self
                .store
                .find_worktree_by_path(repository_id, &info.path)?
            {
                existing.branch = info.branch;
                existing.head = info.head;
                existing.updated_at = now.to_string();
                self.store.upsert_worktree(&existing)?;
            } else {
                let worktree = Worktree {
                    id: WorktreeId::new(),
                    repository_id,
                    path: info.path,
                    branch: info.branch,
                    head: info.head,
                    created_at: now.to_string(),
                    updated_at: now.to_string(),
                };
                self.store.upsert_worktree(&worktree)?;
            }
        }
        self.store.list_worktrees(repository_id)
    }

    fn preference_id(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .store
            .get_preference(key)?
            .filter(|value| !value.is_empty()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::fakes::{FakeGit, FakeStore};
    use crate::domain::WorktreeInfo;
    use crate::ports::Store;
    use std::path::PathBuf;

    #[test]
    fn open_repository_creates_session_provenance() {
        let root = PathBuf::from("/tmp/ataraxia-demo");
        let git = FakeGit::with_repo(
            root.clone(),
            vec![WorktreeInfo {
                path: root.clone(),
                branch: Some("main".into()),
                head: Some("abc".into()),
            }],
        );
        let mut store = FakeStore::default();
        store.healthy = true;
        let service = WorkspaceService {
            git: &git,
            store: &store,
        };

        let snapshot = service.open_repository(&root).expect("open");
        assert_eq!(snapshot.repositories.len(), 1);
        assert_eq!(snapshot.worktrees.len(), 1);

        let repo_id = snapshot.repositories[0].id;
        let worktree_id = snapshot.worktrees[0].id;
        let snapshot = service
            .create_session(repo_id, worktree_id, None, ProviderKind::Fake)
            .expect("create");
        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(snapshot.sessions[0].provider, ProviderKind::Fake);

        // reopen same path is idempotent
        let snapshot = service.open_repository(&root).expect("reopen");
        assert_eq!(snapshot.repositories.len(), 1);
        assert_eq!(store.list_repositories().unwrap().len(), 1);
    }
}
