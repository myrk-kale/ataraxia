//! Workspace use-cases: repositories, worktrees, chat sessions.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::domain::agent::ProviderKind;
use crate::domain::ids::{RepositoryId, SessionId, WorktreeId};
use crate::domain::time::now_rfc3339;
use crate::domain::{
    ChatSession, Error, ErrorCode, Repository, Result, SessionKind, SessionStatus, Worktree,
};
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

/// A branch as the selector shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BranchView {
    pub name: String,
    pub current: bool,
    /// The worktree that already has it checked out, when it is one of the repository's.
    pub worktree_id: Option<WorktreeId>,
}

/// Every local branch, plus the workspace as it is now (the worktree list is refreshed first).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BranchList {
    pub branches: Vec<BranchView>,
    pub workspace: WorkspaceSnapshot,
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

    fn worktree_of(&self, worktree_id: WorktreeId) -> Result<(Repository, Worktree)> {
        let worktree = self
            .store
            .get_worktree(worktree_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "worktree not found"))?;
        let repository = self
            .store
            .get_repository(worktree.repository_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "repository not found"))?;
        Ok((repository, worktree))
    }

    /// All local branches of the repository `worktree_id` belongs to. The worktrees are read
    /// again from git first, so a branch checked out or created outside the app shows up.
    pub fn list_branches(&self, worktree_id: WorktreeId) -> Result<BranchList> {
        let (repository, worktree) = self.worktree_of(worktree_id)?;
        let now = now_rfc3339()?;
        let worktrees = self.sync_worktrees(repository.id, &repository.root, &now)?;
        let branches = self
            .git
            .list_branches(&worktree.path)?
            .into_iter()
            .map(|branch| BranchView {
                worktree_id: branch.worktree_path.as_ref().and_then(|path| {
                    worktrees
                        .iter()
                        .find(|item| &item.path == path)
                        .map(|item| item.id)
                }),
                name: branch.name,
                current: branch.current,
            })
            .collect();
        Ok(BranchList {
            branches,
            workspace: self.bootstrap()?,
        })
    }

    /// Moves to a branch. One a worktree already has open selects that worktree; any other is
    /// checked out in this one, never forced and never while an agent is working in it. When git
    /// refuses, the error says why and nothing has changed.
    pub fn select_branch(&self, worktree_id: WorktreeId, name: &str) -> Result<WorkspaceSnapshot> {
        let (repository, worktree) = self.worktree_of(worktree_id)?;
        let now = now_rfc3339()?;
        self.sync_worktrees(repository.id, &repository.root, &now)?;
        let branch = self
            .git
            .list_branches(&worktree.path)?
            .into_iter()
            .find(|branch| branch.name == name)
            .ok_or_else(|| {
                Error::new(ErrorCode::NotFound, format!("there is no branch `{name}`"))
            })?;
        if branch.current {
            return self.select_worktree(worktree_id);
        }
        if let Some(path) = &branch.worktree_path {
            if let Some(open) = self.store.find_worktree_by_path(repository.id, path)? {
                return self.select_worktree(open.id);
            }
        }
        let busy = self
            .store
            .list_sessions(repository.id)?
            .into_iter()
            .any(|session| {
                session.worktree_id == worktree_id && session.status == SessionStatus::Working
            });
        if busy {
            return Err(Error::new(
                ErrorCode::Invalid,
                format!(
                    "could not switch to `{name}`: an agent is working in this worktree, switch after it finishes"
                ),
            ));
        }
        self.git
            .switch_branch(&worktree.path, name)
            .map_err(|error| {
                Error::new(
                    ErrorCode::Invalid,
                    format!("could not switch to `{name}`: {}", error.message),
                )
            })?;
        self.sync_worktrees(repository.id, &repository.root, &now_rfc3339()?)?;
        self.select_worktree(worktree_id)
    }

    /// Follows git: notices when a worktree's `HEAD` moved (a checkout in a terminal, a branch
    /// switch by another tool) and, now and then, when worktrees were added or removed. `seen`
    /// holds what each worktree's `HEAD` said last time; the first call only fills it. Returns
    /// whether what the app shows (worktrees and their branches) changed and was updated.
    pub fn follow_git(
        &self,
        seen: &mut std::collections::HashMap<WorktreeId, String>,
        rediscover: bool,
    ) -> Result<bool> {
        let first = seen.is_empty();
        let mut moved = false;
        let mut repositories = Vec::new();
        for repository in self.store.list_repositories()? {
            let worktrees = self.store.list_worktrees(repository.id)?;
            for worktree in &worktrees {
                // A worktree whose folder is gone or unreadable is left as it is.
                if let Ok(marker) = self.git.head_marker(&worktree.path) {
                    if seen.insert(worktree.id, marker.clone()) != Some(marker) {
                        moved = true;
                    }
                }
            }
            repositories.push((repository, worktrees));
        }
        if first || !(moved || rediscover) {
            return Ok(false);
        }
        let shape = |worktrees: &[Worktree]| -> Vec<(WorktreeId, Option<String>, Option<String>)> {
            worktrees
                .iter()
                .map(|item| (item.id, item.branch.clone(), item.head.clone()))
                .collect()
        };
        let now = now_rfc3339()?;
        let mut changed = false;
        for (repository, before) in repositories {
            let Ok(after) = self.sync_worktrees(repository.id, &repository.root, &now) else {
                continue;
            };
            changed |= shape(&before) != shape(&after);
        }
        Ok(changed)
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
            kind: SessionKind::Chat,
            parent_session_id: None,
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

    mod real_git {
        use super::*;
        use crate::adapters::git::GitCli;
        use crate::adapters::sqlite::SqliteStore;
        use std::process::Command;

        fn git(repo: &std::path::Path, args: &[&str]) {
            let out = Command::new("git")
                .args(args)
                .current_dir(repo)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }

        fn head_name(repo: &std::path::Path) -> String {
            let out = Command::new("git")
                .args(["rev-parse", "--abbrev-ref", "HEAD"])
                .current_dir(repo)
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }

        /// A repository on `main` with branches `feature/a`, `feature/b`, `fix/c`, where
        /// `fix/c` is also open in a second worktree.
        fn setup() -> (PathBuf, PathBuf, SqliteStore) {
            let base =
                std::env::temp_dir().join(format!("ataraxia-branches-{}", uuid::Uuid::new_v4()));
            let repo = base.join("repo");
            std::fs::create_dir_all(&repo).unwrap();
            git(&repo, &["init", "-q", "-b", "main"]);
            git(&repo, &["config", "user.email", "a@b.c"]);
            git(&repo, &["config", "user.name", "t"]);
            git(&repo, &["config", "commit.gpgsign", "false"]);
            std::fs::write(repo.join("a.txt"), "base\n").unwrap();
            git(&repo, &["add", "."]);
            git(&repo, &["commit", "-q", "-m", "init"]);
            for name in ["feature/a", "feature/b", "fix/c"] {
                git(&repo, &["branch", name]);
            }
            git(&repo, &["checkout", "-q", "feature/b"]);
            std::fs::write(repo.join("a.txt"), "changed on b\n").unwrap();
            git(&repo, &["commit", "-qam", "b edits a"]);
            git(&repo, &["checkout", "-q", "main"]);
            let other = base.join("fix-c");
            git(
                &repo,
                &["worktree", "add", "-q", other.to_str().unwrap(), "fix/c"],
            );
            (repo, other, SqliteStore::open_in_memory().unwrap())
        }

        #[test]
        fn every_local_branch_is_listed_and_the_list_is_read_from_git_each_time() {
            let (repo, other, store) = setup();
            let service = WorkspaceService {
                git: &GitCli,
                store: &store,
            };
            let snapshot = service.open_repository(&repo).unwrap();
            let id = snapshot.selected_worktree_id.unwrap();

            let list = service.list_branches(id).unwrap();
            let names: Vec<&str> = list.branches.iter().map(|b| b.name.as_str()).collect();
            for expected in ["main", "feature/a", "feature/b", "fix/c"] {
                assert!(names.contains(&expected), "{expected} in {names:?}");
            }
            assert!(
                list.branches
                    .iter()
                    .find(|b| b.name == "main")
                    .unwrap()
                    .current
            );
            // A branch another worktree holds points at that worktree; a free one at none.
            let fix = list.branches.iter().find(|b| b.name == "fix/c").unwrap();
            assert!(fix.worktree_id.is_some());
            assert!(
                list.branches
                    .iter()
                    .find(|b| b.name == "feature/a")
                    .unwrap()
                    .worktree_id
                    .is_none()
            );

            // A branch made outside the app shows up the next time the selector opens.
            git(&repo, &["branch", "made-later"]);
            let again = service.list_branches(id).unwrap();
            assert!(again.branches.iter().any(|b| b.name == "made-later"));
            let _ = other;
            let _ = std::fs::remove_dir_all(repo.parent().unwrap());
        }

        #[test]
        fn choosing_a_free_branch_switches_to_it_and_one_open_elsewhere_selects_that_worktree() {
            let (repo, other, store) = setup();
            let service = WorkspaceService {
                git: &GitCli,
                store: &store,
            };
            let id = service
                .open_repository(&repo)
                .unwrap()
                .selected_worktree_id
                .unwrap();

            let snapshot = service.select_branch(id, "feature/a").unwrap();
            assert_eq!(head_name(&repo), "feature/a");
            let selected = snapshot
                .worktrees
                .iter()
                .find(|w| Some(w.id) == snapshot.selected_worktree_id)
                .unwrap();
            assert_eq!(selected.id, id);
            assert_eq!(selected.branch.as_deref(), Some("feature/a"));

            // fix/c lives in its own worktree: that one is selected and the first stays put.
            let snapshot = service.select_branch(id, "fix/c").unwrap();
            let selected = snapshot
                .worktrees
                .iter()
                .find(|w| Some(w.id) == snapshot.selected_worktree_id)
                .unwrap();
            assert_eq!(
                selected.path.canonicalize().unwrap(),
                other.canonicalize().unwrap()
            );
            assert_eq!(head_name(&repo), "feature/a");
            // The branch already open is a no-op, not an error.
            assert!(service.select_branch(id, "feature/a").is_ok());
            let _ = std::fs::remove_dir_all(repo.parent().unwrap());
        }

        #[test]
        fn a_switch_git_refuses_is_reported_with_its_reason_and_changes_nothing() {
            let (repo, _other, store) = setup();
            let service = WorkspaceService {
                git: &GitCli,
                store: &store,
            };
            let id = service
                .open_repository(&repo)
                .unwrap()
                .selected_worktree_id
                .unwrap();

            // Local edits that feature/b would overwrite.
            std::fs::write(repo.join("a.txt"), "my unsaved work\n").unwrap();
            let error = service.select_branch(id, "feature/b").unwrap_err();
            assert!(
                error
                    .message
                    .starts_with("could not switch to `feature/b`:"),
                "{}",
                error.message
            );
            assert!(error.message.contains("a.txt"), "{}", error.message);
            assert_eq!(head_name(&repo), "main");
            assert_eq!(
                std::fs::read_to_string(repo.join("a.txt")).unwrap(),
                "my unsaved work\n"
            );

            // A name that is not a local branch is refused before git is asked.
            assert_eq!(
                service.select_branch(id, "origin/nope").unwrap_err().code,
                ErrorCode::NotFound
            );
            assert!(service.select_branch(id, "--detach").is_err());
            let _ = std::fs::remove_dir_all(repo.parent().unwrap());
        }

        #[test]
        fn a_marker_left_by_a_stopped_revert_does_not_stand_in_the_way() {
            let (repo, _other, store) = setup();
            let service = WorkspaceService {
                git: &GitCli,
                store: &store,
            };
            let id = service
                .open_repository(&repo)
                .unwrap()
                .selected_worktree_id
                .unwrap();
            // What a stopped `git revert` leaves behind: `git switch` refuses on it alone.
            let head = Command::new("git")
                .args(["rev-parse", "HEAD"])
                .current_dir(&repo)
                .output()
                .unwrap();
            std::fs::write(repo.join(".git/REVERT_HEAD"), head.stdout).unwrap();

            let snapshot = service.select_branch(id, "feature/a").unwrap();
            assert_eq!(head_name(&repo), "feature/a");
            let selected = snapshot.worktrees.iter().find(|w| w.id == id).unwrap();
            assert_eq!(selected.branch.as_deref(), Some("feature/a"));

            // A file with the same name as a branch does not confuse it.
            std::fs::write(repo.join("feature"), "a file").unwrap();
            git(&repo, &["add", "feature"]);
            git(
                &repo,
                &["commit", "-qm", "a file named like a branch prefix"],
            );
            assert!(service.select_branch(id, "main").is_ok());
            assert_eq!(head_name(&repo), "main");
            let _ = std::fs::remove_dir_all(repo.parent().unwrap());
        }

        #[test]
        fn unmerged_paths_still_stop_a_switch_with_gits_reason() {
            let (repo, _other, store) = setup();
            let service = WorkspaceService {
                git: &GitCli,
                store: &store,
            };
            let id = service
                .open_repository(&repo)
                .unwrap()
                .selected_worktree_id
                .unwrap();
            // A merge that conflicts: this is a real impediment.
            git(&repo, &["checkout", "-q", "feature/b"]);
            std::fs::write(repo.join("a.txt"), "feature side\n").unwrap();
            git(&repo, &["commit", "-qam", "feature side"]);
            git(&repo, &["checkout", "-q", "main"]);
            std::fs::write(repo.join("a.txt"), "main side\n").unwrap();
            git(&repo, &["commit", "-qam", "main side"]);
            let _ = Command::new("git")
                .args(["merge", "feature/b"])
                .current_dir(&repo)
                .output()
                .unwrap();
            let error = service.select_branch(id, "feature/a").unwrap_err();
            assert!(
                error
                    .message
                    .starts_with("could not switch to `feature/a`:"),
                "{}",
                error.message
            );
            assert_eq!(head_name(&repo), "main");
            let _ = std::fs::remove_dir_all(repo.parent().unwrap());
        }

        #[test]
        fn a_branch_switched_in_a_terminal_is_followed_and_so_is_a_new_worktree() {
            let (repo, _other, store) = setup();
            let service = WorkspaceService {
                git: &GitCli,
                store: &store,
            };
            let snapshot = service.open_repository(&repo).unwrap();
            let id = snapshot.selected_worktree_id.unwrap();
            let mut seen = std::collections::HashMap::new();

            // The first look only learns where every HEAD is, and nothing has moved since.
            assert!(!service.follow_git(&mut seen, false).unwrap());
            assert!(!service.follow_git(&mut seen, false).unwrap());
            assert!(!service.follow_git(&mut seen, true).unwrap());

            // `git checkout` in a terminal: the app follows without being asked.
            git(&repo, &["checkout", "-q", "feature/a"]);
            assert!(service.follow_git(&mut seen, false).unwrap());
            let branch = |service: &WorkspaceService| {
                service
                    .bootstrap()
                    .unwrap()
                    .worktrees
                    .into_iter()
                    .find(|w| w.id == id)
                    .unwrap()
                    .branch
            };
            assert_eq!(branch(&service).as_deref(), Some("feature/a"));
            // And only once: the same HEAD is not news again.
            assert!(!service.follow_git(&mut seen, false).unwrap());

            // A branch created and checked out, and a detached HEAD, are followed the same way.
            git(&repo, &["checkout", "-q", "-b", "made/in-terminal"]);
            assert!(service.follow_git(&mut seen, false).unwrap());
            assert_eq!(branch(&service).as_deref(), Some("made/in-terminal"));
            git(&repo, &["checkout", "-q", "--detach"]);
            assert!(service.follow_git(&mut seen, false).unwrap());
            assert_eq!(branch(&service), None);

            // A worktree added outside the app shows up when the list is read again.
            let added = repo.parent().unwrap().join("added-later");
            git(
                &repo,
                &[
                    "worktree",
                    "add",
                    "-q",
                    "-b",
                    "later",
                    added.to_str().unwrap(),
                ],
            );
            assert!(
                !service.follow_git(&mut seen, false).unwrap(),
                "the list is only re-read now and then"
            );
            assert!(service.follow_git(&mut seen, true).unwrap());
            assert!(
                service
                    .bootstrap()
                    .unwrap()
                    .worktrees
                    .iter()
                    .any(|w| w.branch.as_deref() == Some("later"))
            );
            // The switch made in the app and the one made in the terminal agree.
            service.select_branch(id, "main").unwrap();
            assert_eq!(head_name(&repo), "main");
            let _ = service.follow_git(&mut seen, false);
            assert!(!service.follow_git(&mut seen, false).unwrap());
            let _ = std::fs::remove_dir_all(repo.parent().unwrap());
        }

        #[test]
        fn nothing_is_switched_while_an_agent_works_in_the_worktree() {
            let (repo, _other, store) = setup();
            let service = WorkspaceService {
                git: &GitCli,
                store: &store,
            };
            let snapshot = service.open_repository(&repo).unwrap();
            let (repository, id) = (
                snapshot.repositories[0].id,
                snapshot.selected_worktree_id.unwrap(),
            );
            let snapshot = service
                .create_session(repository, id, None, ProviderKind::Fake)
                .unwrap();
            let session = snapshot.sessions[0].id;
            store
                .update_session_status(session, SessionStatus::Working, "2026-01-01T00:00:00Z")
                .unwrap();

            let error = service.select_branch(id, "feature/a").unwrap_err();
            assert!(
                error.message.contains("an agent is working"),
                "{}",
                error.message
            );
            assert_eq!(head_name(&repo), "main");

            store
                .update_session_status(session, SessionStatus::Idle, "2026-01-01T00:00:01Z")
                .unwrap();
            assert!(service.select_branch(id, "feature/a").is_ok());
            let _ = std::fs::remove_dir_all(repo.parent().unwrap());
        }
    }
}
