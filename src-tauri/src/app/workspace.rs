//! Workspace use-cases: repositories, worktrees, chat sessions.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::domain::agent::ProviderKind;
use crate::domain::ids::{RepositoryId, SessionId, WorkspaceId, WorktreeId};
use crate::domain::time::now_rfc3339;
use crate::domain::{
    ChatSession, Error, ErrorCode, Repository, Result, SessionKind, SessionStatus, Workspace,
    Worktree,
};
use crate::ports::{FilesProbe, Git, Store};

const PREF_SELECTED_REPO: &str = "selected_repository_id";
const PREF_SELECTED_WORKTREE: &str = "selected_worktree_id";
const PREF_SELECTED_SESSION: &str = "selected_session_id";
const PREF_SELECTED_WORKSPACE: &str = "selected_workspace_id";

/// The repository a workspace was last looking at.
fn focus_key(workspace_id: WorkspaceId) -> String {
    format!("focus_repository:{}", workspace_id.0)
}

/// The worktree of a repository the user last had selected.
fn worktree_key(repository_id: RepositoryId) -> String {
    format!("worktree_of:{}", repository_id.0)
}

const MAX_WORKSPACE_NAME: usize = 60;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceSnapshot {
    pub repositories: Vec<Repository>,
    pub workspaces: Vec<Workspace>,
    pub selected_workspace_id: Option<WorkspaceId>,
    /// The repository in focus: the one Code, the terminal and the branch selector show. It is
    /// always a member of the selected workspace.
    pub selected_repository_id: Option<RepositoryId>,
    /// The worktrees of every repository of the selected workspace, the one in focus first.
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

/// What the files of a worktree looked like the last time [`WorkspaceService::follow_files`]
/// looked.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FilesSeen {
    probe: FilesProbe,
    status: String,
}

/// The repositories a chat sees as (name, folder): its own first, then one worktree of every
/// other member of its workspace.
pub fn session_roots(
    store: &dyn Store,
    session: &ChatSession,
) -> Result<Vec<(String, std::path::PathBuf)>> {
    let mut ids = vec![session.worktree_id];
    ids.extend(store.session_worktrees(session.id)?);
    let mut roots: Vec<(RepositoryId, String, std::path::PathBuf)> = Vec::new();
    for id in ids {
        let Some(worktree) = store.get_worktree(id)? else {
            continue;
        };
        if roots
            .iter()
            .any(|(repo, _, _)| *repo == worktree.repository_id)
        {
            continue;
        }
        let name = store
            .get_repository(worktree.repository_id)?
            .map(|repository| repository.name)
            .unwrap_or_default();
        roots.push((worktree.repository_id, name, worktree.path));
    }
    Ok(roots
        .into_iter()
        .map(|(_, name, path)| (name, path))
        .collect())
}

/// The files a chat can name to Ataraxia: those of its own repository as they are, and those of
/// every other repository of the workspace as `<repository>/<path>`.
pub fn known_files(
    store: &dyn Store,
    git: &dyn Git,
    session: &ChatSession,
) -> Result<std::collections::HashSet<String>> {
    let mut known = std::collections::HashSet::new();
    for (index, (name, path)) in session_roots(store, session)?.into_iter().enumerate() {
        let files = match git.list_files(&path) {
            Ok(files) => files,
            // The first one is the chat's own and has to be readable; another may be gone.
            Err(error) if index == 0 => return Err(error),
            Err(_) => continue,
        };
        if index == 0 {
            known.extend(files);
        } else {
            known.extend(files.into_iter().map(|file| format!("{name}/{file}")));
        }
    }
    Ok(known)
}

pub struct WorkspaceService<'a> {
    pub git: &'a dyn Git,
    pub store: &'a dyn Store,
}

impl<'a> WorkspaceService<'a> {
    pub fn bootstrap(&self) -> Result<WorkspaceSnapshot> {
        let repositories = self.store.list_repositories()?;
        let workspaces = self.store.list_workspaces()?;
        let selected = self.resolve_workspace(&workspaces)?;
        let selected_workspace_id = selected.map(|workspace| workspace.id);
        let selected_repository_id = match selected {
            Some(workspace) => self.resolve_focus(workspace, &repositories)?,
            None => None,
        };

        let (worktrees, sessions, selected_worktree_id, selected_session_id) =
            if let (Some(workspace), Some(repository_id)) = (selected, selected_repository_id) {
                let focus_worktrees = self.store.list_worktrees(repository_id)?;
                let sessions = self.store.list_workspace_sessions(workspace.id)?;
                let remembered = |key: &str| -> Result<Option<WorktreeId>> {
                    Ok(self.preference_id(key)?.and_then(|id| {
                        focus_worktrees
                            .iter()
                            .find(|item| item.id.0.to_string() == id)
                            .map(|item| item.id)
                    }))
                };
                let selected_worktree_id = match remembered(PREF_SELECTED_WORKTREE)? {
                    Some(id) => Some(id),
                    None => match remembered(&worktree_key(repository_id))? {
                        Some(id) => Some(id),
                        None => focus_worktrees.first().map(|item| item.id),
                    },
                };
                // The worktrees of every member, the one in focus first: the sessions list names the
                // worktree each chat runs in, and that may be in another member.
                let mut worktrees = focus_worktrees.clone();
                for member in &workspace.repository_ids {
                    if *member != repository_id {
                        worktrees.extend(self.store.list_worktrees(*member)?);
                    }
                }
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
            workspaces,
            selected_workspace_id,
            selected_repository_id,
            worktrees,
            selected_worktree_id,
            sessions,
            selected_session_id,
        })
    }

    /// The workspace on screen: the one chosen last, else the one that holds the repository that
    /// was selected before workspaces existed, else the first.
    fn resolve_workspace<'w>(&self, workspaces: &'w [Workspace]) -> Result<Option<&'w Workspace>> {
        if let Some(id) = self.preference_id(PREF_SELECTED_WORKSPACE)? {
            if let Some(found) = workspaces.iter().find(|item| item.id.0.to_string() == id) {
                return Ok(Some(found));
            }
        }
        if let Some(id) = self.preference_id(PREF_SELECTED_REPO)? {
            let holding =
                |item: &&Workspace| item.repository_ids.iter().any(|r| r.0.to_string() == id);
            let alone = |item: &&Workspace| item.repository_ids.len() == 1;
            if let Some(found) = workspaces
                .iter()
                .find(|item| holding(item) && alone(item))
                .or_else(|| workspaces.iter().find(holding))
            {
                return Ok(Some(found));
            }
        }
        Ok(workspaces.first())
    }

    /// The member of `workspace` that is in focus: the one it looked at last, else the repository
    /// that was selected, else its first member.
    fn resolve_focus(
        &self,
        workspace: &Workspace,
        repositories: &[Repository],
    ) -> Result<Option<RepositoryId>> {
        let member = |id: &str| {
            workspace
                .repository_ids
                .iter()
                .copied()
                .find(|item| item.0.to_string() == id)
                .filter(|item| repositories.iter().any(|repo| repo.id == *item))
        };
        for key in [focus_key(workspace.id), PREF_SELECTED_REPO.to_string()] {
            if let Some(found) = self.preference_id(&key)?.and_then(|id| member(&id)) {
                return Ok(Some(found));
            }
        }
        Ok(workspace
            .repository_ids
            .iter()
            .copied()
            .find(|item| repositories.iter().any(|repo| repo.id == *item)))
    }

    /// Makes `workspace` the one on screen. Another workspace has other chats, so the chat that
    /// was open is left.
    fn show_workspace(&self, workspace_id: WorkspaceId) -> Result<()> {
        let changed = self.preference_id(PREF_SELECTED_WORKSPACE)?.as_deref()
            != Some(workspace_id.0.to_string().as_str());
        self.store
            .set_preference(PREF_SELECTED_WORKSPACE, &workspace_id.0.to_string())?;
        if changed {
            self.store.set_preference(PREF_SELECTED_SESSION, "")?;
        }
        Ok(())
    }

    /// Puts `repository_id` in focus inside `workspace_id`.
    fn focus(&self, workspace_id: WorkspaceId, repository_id: RepositoryId) -> Result<()> {
        let id = repository_id.0.to_string();
        self.store.set_preference(&focus_key(workspace_id), &id)?;
        self.store.set_preference(PREF_SELECTED_REPO, &id)
    }

    fn remember_worktree(&self, worktree: &Worktree) -> Result<()> {
        let id = worktree.id.0.to_string();
        self.store
            .set_preference(&worktree_key(worktree.repository_id), &id)?;
        self.store.set_preference(PREF_SELECTED_WORKTREE, &id)
    }

    /// The worktree of a repository the user last had selected there, else its main checkout.
    fn default_worktree(&self, repository: &Repository) -> Result<Option<Worktree>> {
        let worktrees = self.store.list_worktrees(repository.id)?;
        if let Some(id) = self.preference_id(&worktree_key(repository.id))? {
            if let Some(found) = worktrees.iter().find(|item| item.id.0.to_string() == id) {
                return Ok(Some(found.clone()));
            }
        }
        Ok(worktrees
            .iter()
            .find(|item| item.path == repository.root)
            .or_else(|| worktrees.first())
            .cloned())
    }

    /// A workspace to show a repository in: the selected one when it is a member, else a
    /// workspace of that repository alone, else any that holds it.
    fn workspace_for(&self, repository_id: RepositoryId) -> Result<Option<Workspace>> {
        let workspaces = self.store.list_workspaces()?;
        if let Some(selected) = self.resolve_workspace(&workspaces)? {
            if selected.repository_ids.contains(&repository_id) {
                return Ok(Some(selected.clone()));
            }
        }
        Ok(workspaces
            .iter()
            .find(|item| item.repository_ids == [repository_id])
            .or_else(|| {
                workspaces
                    .iter()
                    .find(|item| item.repository_ids.contains(&repository_id))
            })
            .cloned())
    }

    /// Finds or records the repository at `path` and reads its worktrees, selecting nothing.
    pub fn register_repository(&self, path: impl AsRef<Path>) -> Result<Repository> {
        let info = self.git.discover(path.as_ref()).map_err(|error| {
            if error.code == ErrorCode::Io || error.code == ErrorCode::NotARepo {
                Error::new(ErrorCode::NotARepo, error.message)
            } else {
                error
            }
        })?;
        let now = now_rfc3339()?;
        let repository = match self.store.find_repository_by_root(&info.root)? {
            Some(mut existing) => {
                existing.name = info.name;
                existing.updated_at = now.clone();
                self.store.upsert_repository(&existing)?;
                existing
            }
            None => {
                let repository = Repository {
                    id: RepositoryId::new(),
                    root: info.root.clone(),
                    name: info.name,
                    created_at: now.clone(),
                    updated_at: now.clone(),
                };
                self.store.upsert_repository(&repository)?;
                repository
            }
        };
        self.sync_worktrees(repository.id, &repository.root, &now)?;
        Ok(repository)
    }

    /// Opens a folder: its repository becomes a workspace of one (or that workspace is shown
    /// again) with the repository in focus.
    pub fn open_repository(&self, path: impl AsRef<Path>) -> Result<WorkspaceSnapshot> {
        let repository = self.register_repository(path.as_ref())?;
        let alone = self
            .store
            .list_workspaces()?
            .into_iter()
            .find(|item| item.repository_ids == [repository.id]);
        let workspace = match alone {
            Some(found) => found,
            None => {
                let now = now_rfc3339()?;
                let workspace = Workspace {
                    id: WorkspaceId::new(),
                    name: self.free_workspace_name(&repository.name, None)?,
                    repository_ids: vec![repository.id],
                    created_at: now.clone(),
                    updated_at: now,
                };
                self.store.upsert_workspace(&workspace)?;
                workspace
            }
        };
        self.show_workspace(workspace.id)?;
        self.focus(workspace.id, repository.id)?;
        // The folder that was opened is the checkout to show, even when the repository has more.
        let worktrees = self.store.list_worktrees(repository.id)?;
        let opened = worktrees
            .iter()
            .find(|item| item.path == repository.root)
            .or_else(|| worktrees.first());
        if let Some(worktree) = opened {
            self.remember_worktree(worktree)?;
        }
        self.bootstrap()
    }

    /// Shows a workspace, with the repository it was looking at last in focus.
    pub fn select_workspace(&self, workspace_id: WorkspaceId) -> Result<WorkspaceSnapshot> {
        let workspace = self
            .store
            .get_workspace(workspace_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "workspace not found"))?;
        self.show_workspace(workspace.id)?;
        let repositories = self.store.list_repositories()?;
        if let Some(repository_id) = self.resolve_focus(&workspace, &repositories)? {
            self.focus(workspace.id, repository_id)?;
            if let Some(repository) = repositories.iter().find(|item| item.id == repository_id) {
                let _ = self.sync_worktrees(repository.id, &repository.root, &now_rfc3339()?);
                self.store.set_preference(PREF_SELECTED_WORKTREE, "")?;
            }
        }
        self.bootstrap()
    }

    /// Puts a repository in focus. Inside the workspace on screen the chat stays open, because
    /// the chat belongs to the workspace and not to the repository being looked at.
    pub fn select_repository(&self, repository_id: RepositoryId) -> Result<WorkspaceSnapshot> {
        let repository = self
            .store
            .get_repository(repository_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "repository not found"))?;
        let workspace = self
            .workspace_for(repository.id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "that repository is in no workspace"))?;
        self.show_workspace(workspace.id)?;
        self.focus(workspace.id, repository.id)?;
        let _ = self.sync_worktrees(repository.id, &repository.root, &now_rfc3339()?);
        if let Some(worktree) = self.default_worktree(&repository)? {
            self.remember_worktree(&worktree)?;
        }
        self.bootstrap()
    }

    pub fn select_worktree(&self, worktree_id: WorktreeId) -> Result<WorkspaceSnapshot> {
        let worktree = self
            .store
            .get_worktree(worktree_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "worktree not found"))?;
        let workspace = self
            .workspace_for(worktree.repository_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "that repository is in no workspace"))?;
        self.show_workspace(workspace.id)?;
        self.focus(workspace.id, worktree.repository_id)?;
        self.remember_worktree(&worktree)?;
        self.bootstrap()
    }

    fn clean_workspace_input(
        &self,
        id: Option<WorkspaceId>,
        name: &str,
        repository_ids: &[RepositoryId],
    ) -> Result<(String, Vec<RepositoryId>)> {
        let name = name.trim();
        if name.is_empty() {
            return Err(Error::new(ErrorCode::Invalid, "a workspace needs a name"));
        }
        if name.chars().count() > MAX_WORKSPACE_NAME {
            return Err(Error::new(
                ErrorCode::Invalid,
                format!("a workspace name has at most {MAX_WORKSPACE_NAME} characters"),
            ));
        }
        let taken =
            self.store.list_workspaces()?.into_iter().any(|other| {
                Some(other.id) != id && other.name.to_lowercase() == name.to_lowercase()
            });
        if taken {
            return Err(Error::new(
                ErrorCode::Invalid,
                format!("a workspace named `{name}` already exists"),
            ));
        }
        let mut members: Vec<RepositoryId> = Vec::new();
        for repository_id in repository_ids {
            if members.contains(repository_id) {
                continue;
            }
            if self.store.get_repository(*repository_id)?.is_none() {
                return Err(Error::new(ErrorCode::NotFound, "repository not found"));
            }
            members.push(*repository_id);
        }
        if members.is_empty() {
            return Err(Error::new(
                ErrorCode::Invalid,
                "a workspace needs at least one repository",
            ));
        }
        Ok((name.to_string(), members))
    }

    /// A name no other workspace has, for the one made when a folder is opened.
    fn free_workspace_name(&self, wanted: &str, id: Option<WorkspaceId>) -> Result<String> {
        let names: Vec<String> = self
            .store
            .list_workspaces()?
            .into_iter()
            .filter(|item| Some(item.id) != id)
            .map(|item| item.name.to_lowercase())
            .collect();
        let mut name = wanted.to_string();
        let mut n = 2;
        while names.contains(&name.to_lowercase()) {
            name = format!("{wanted} {n}");
            n += 1;
        }
        Ok(name)
    }

    pub fn create_workspace(
        &self,
        name: &str,
        repository_ids: &[RepositoryId],
    ) -> Result<WorkspaceSnapshot> {
        let (name, members) = self.clean_workspace_input(None, name, repository_ids)?;
        let now = now_rfc3339()?;
        let workspace = Workspace {
            id: WorkspaceId::new(),
            name,
            repository_ids: members,
            created_at: now.clone(),
            updated_at: now,
        };
        self.store.upsert_workspace(&workspace)?;
        // A new workspace starts on its first member.
        self.store.set_preference(
            &focus_key(workspace.id),
            &workspace.repository_ids[0].0.to_string(),
        )?;
        self.select_workspace(workspace.id)
    }

    pub fn update_workspace(
        &self,
        workspace_id: WorkspaceId,
        name: &str,
        repository_ids: &[RepositoryId],
    ) -> Result<WorkspaceSnapshot> {
        let existing = self
            .store
            .get_workspace(workspace_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "workspace not found"))?;
        let (name, members) =
            self.clean_workspace_input(Some(workspace_id), name, repository_ids)?;
        self.store.upsert_workspace(&Workspace {
            name,
            repository_ids: members,
            updated_at: now_rfc3339()?,
            ..existing
        })?;
        self.bootstrap()
    }

    /// Removes a workspace that has no chats. Its repositories stay known.
    pub fn delete_workspace(&self, workspace_id: WorkspaceId) -> Result<WorkspaceSnapshot> {
        let chats = self.store.list_workspace_sessions(workspace_id)?.len();
        if chats > 0 {
            return Err(Error::new(
                ErrorCode::Invalid,
                format!(
                    "this workspace still has {chats} chat{}: delete them first",
                    if chats == 1 { "" } else { "s" }
                ),
            ));
        }
        self.store.delete_workspace(workspace_id)?;
        if self.preference_id(PREF_SELECTED_WORKSPACE)?.as_deref()
            == Some(workspace_id.0.to_string().as_str())
        {
            self.store.set_preference(PREF_SELECTED_WORKSPACE, "")?;
            self.store.set_preference(PREF_SELECTED_SESSION, "")?;
        }
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
        let busy = self.agent_working_in(&repository, worktree_id)?;
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

    /// Follows the files of the selected worktree: notices when they changed under the app (a
    /// `git rm`, `checkout`, `stash` or `pull` in a terminal, or a file made or deleted by
    /// another program) and returns that worktree.
    ///
    /// Each call reads the probe (file reads only). The status, which costs a git process, is
    /// read when the probe moved, when `check_status` says it is time, and the first time a
    /// worktree is seen, which only fills `seen`. The index moving on its own (another tool
    /// refreshing it) is not news: what counts is `HEAD`, or the status, differing from last time.
    pub fn follow_files(
        &self,
        seen: &mut HashMap<WorktreeId, FilesSeen>,
        check_status: bool,
    ) -> Result<Option<WorktreeId>> {
        let selected = self
            .preference_id(PREF_SELECTED_WORKTREE)?
            .and_then(|id| uuid::Uuid::parse_str(&id).ok())
            .map(WorktreeId);
        let worktree = match selected {
            Some(id) => self.store.get_worktree(id)?,
            None => None,
        };
        let Some(worktree) = worktree else {
            seen.clear();
            return Ok(None);
        };
        // Only the worktree on screen is watched; coming back to another one reads it fresh.
        seen.retain(|id, _| *id == worktree.id);
        // A worktree whose folder is gone or unreadable is left as it is.
        let Ok(probe) = self.git.files_probe(&worktree.path) else {
            return Ok(None);
        };
        let Some(before) = seen.get_mut(&worktree.id) else {
            let status = self.git.status_stamp(&worktree.path).unwrap_or_default();
            seen.insert(worktree.id, FilesSeen { probe, status });
            return Ok(None);
        };
        let moved = before.probe != probe;
        let head_moved = before.probe.head != probe.head;
        before.probe = probe;
        let mut changed = head_moved;
        if moved || check_status {
            if let Ok(status) = self.git.status_stamp(&worktree.path) {
                changed |= before.status != status;
                before.status = status;
            }
        }
        Ok(changed.then_some(worktree.id))
    }

    /// Whether an agent is working in a worktree, as the chat's own or as one it also sees.
    fn agent_working_in(&self, repository: &Repository, worktree_id: WorktreeId) -> Result<bool> {
        for workspace in self.store.list_workspaces()? {
            if !workspace.repository_ids.contains(&repository.id) {
                continue;
            }
            for session in self.store.list_workspace_sessions(workspace.id)? {
                if session.status != SessionStatus::Working {
                    continue;
                }
                if session.worktree_id == worktree_id
                    || self
                        .store
                        .session_worktrees(session.id)?
                        .contains(&worktree_id)
                {
                    return Ok(true);
                }
            }
        }
        Ok(false)
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
        let workspace = self
            .workspace_for(repository.id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "that repository is in no workspace"))?;

        // The chat sees one worktree of every other member, fixed now: the one selected there,
        // else its main checkout.
        let mut others = Vec::new();
        for member in &workspace.repository_ids {
            if *member == repository.id {
                continue;
            }
            let Some(member) = self.store.get_repository(*member)? else {
                continue;
            };
            let _ = self.sync_worktrees(member.id, &member.root, &now_rfc3339()?);
            if let Some(found) = self.default_worktree(&member)? {
                others.push(found.id);
            }
        }

        let now = now_rfc3339()?;
        let count = self.store.list_workspace_sessions(workspace.id)?.len() + 1;
        let session = ChatSession {
            id: SessionId::new(),
            workspace_id: Some(workspace.id),
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
        self.store.set_session_worktrees(session.id, &others)?;
        self.show_workspace(workspace.id)?;
        self.focus(workspace.id, repository.id)?;
        self.remember_worktree(&worktree)?;
        self.store
            .set_preference(PREF_SELECTED_SESSION, &session.id.0.to_string())?;
        self.bootstrap()
    }

    pub fn open_session(&self, session_id: SessionId) -> Result<WorkspaceSnapshot> {
        let session = self
            .store
            .get_session(session_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "session not found"))?;
        let worktree = self
            .store
            .get_worktree(session.worktree_id)?
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "worktree not found"))?;
        let now = now_rfc3339()?;
        self.store.touch_session(session.id, &now)?;
        let workspace = match session.workspace_id {
            Some(id) => self.store.get_workspace(id)?,
            None => None,
        };
        let workspace = match workspace {
            Some(found) => found,
            None => self
                .workspace_for(session.repository_id)?
                .ok_or_else(|| Error::new(ErrorCode::NotFound, "that chat's workspace is gone"))?,
        };
        self.show_workspace(workspace.id)?;
        self.focus(workspace.id, session.repository_id)?;
        self.remember_worktree(&worktree)?;
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

    /// A fake git with several repositories, one checkout each, named after their folders.
    fn git_with(roots: &[&str]) -> FakeGit {
        let git = FakeGit::default();
        for root in roots {
            let root = PathBuf::from(root);
            let name = root.file_name().unwrap().to_string_lossy().into_owned();
            git.repos.lock().unwrap().insert(
                root.clone(),
                crate::domain::RepoInfo {
                    root: root.clone(),
                    name,
                },
            );
            git.worktrees.lock().unwrap().insert(
                root.clone(),
                vec![WorktreeInfo {
                    path: root,
                    branch: Some("main".into()),
                    head: Some("abc".into()),
                }],
            );
        }
        git
    }

    fn repo_named(snapshot: &WorkspaceSnapshot, name: &str) -> RepositoryId {
        snapshot
            .repositories
            .iter()
            .find(|item| item.name == name)
            .unwrap_or_else(|| panic!("no repository {name}"))
            .id
    }

    #[test]
    fn opening_folders_makes_a_workspace_of_one_each_and_reopening_reuses_it() {
        let git = git_with(&["/w/api", "/w/web"]);
        let store = FakeStore::healthy();
        let service = WorkspaceService {
            git: &git,
            store: &store,
        };

        let first = service.open_repository("/w/api").unwrap();
        assert_eq!(first.workspaces.len(), 1);
        assert_eq!(first.workspaces[0].name, "api");
        let second = service.open_repository("/w/web").unwrap();
        assert_eq!(second.workspaces.len(), 2);
        assert_eq!(
            second.selected_repository_id,
            Some(repo_named(&second, "web"))
        );
        let again = service.open_repository("/w/api").unwrap();
        assert_eq!(again.workspaces.len(), 2);
        let selected = again.selected_workspace_id.unwrap();
        let workspace = again
            .workspaces
            .iter()
            .find(|item| item.id == selected)
            .unwrap();
        assert_eq!(workspace.name, "api");
    }

    #[test]
    fn a_workspace_groups_repositories_and_rejects_bad_input() {
        let git = git_with(&["/w/api", "/w/web"]);
        let store = FakeStore::healthy();
        let service = WorkspaceService {
            git: &git,
            store: &store,
        };
        service.open_repository("/w/api").unwrap();
        let snapshot = service.open_repository("/w/web").unwrap();
        let (api, web) = (repo_named(&snapshot, "api"), repo_named(&snapshot, "web"));

        let made = service
            .create_workspace("  acme  ", &[api, web, api])
            .unwrap();
        let acme = made
            .workspaces
            .iter()
            .find(|item| item.name == "acme")
            .unwrap();
        assert_eq!(
            acme.repository_ids,
            vec![api, web],
            "no duplicates, order kept"
        );
        assert_eq!(made.selected_workspace_id, Some(acme.id));
        assert_eq!(
            made.selected_repository_id,
            Some(api),
            "the first member is in focus"
        );

        let empty = service.create_workspace("none", &[]).unwrap_err();
        assert!(empty.message.contains("at least one"), "{}", empty.message);
        let blank = service.create_workspace("   ", &[api]).unwrap_err();
        assert!(blank.message.contains("needs a name"));
        let taken = service.create_workspace("ACME", &[api]).unwrap_err();
        assert!(taken.message.contains("already exists"));
        let missing = service
            .create_workspace("ghost", &[RepositoryId::new()])
            .unwrap_err();
        assert_eq!(missing.code, ErrorCode::NotFound);

        let renamed = service
            .update_workspace(acme.id, "acme web", &[web])
            .unwrap();
        let acme = renamed
            .workspaces
            .iter()
            .find(|item| item.id == acme.id)
            .unwrap();
        assert_eq!(
            (acme.name.as_str(), acme.repository_ids.clone()),
            ("acme web", vec![web])
        );
        assert_eq!(
            renamed.selected_repository_id,
            Some(web),
            "a focus that left the workspace falls back to a member"
        );
    }

    #[test]
    fn looking_at_another_repository_keeps_the_chat_and_another_workspace_leaves_it() {
        let git = git_with(&["/w/api", "/w/web", "/w/solo"]);
        let store = FakeStore::healthy();
        let service = WorkspaceService {
            git: &git,
            store: &store,
        };
        service.open_repository("/w/api").unwrap();
        service.open_repository("/w/web").unwrap();
        let snapshot = service.open_repository("/w/solo").unwrap();
        let (api, web, solo) = (
            repo_named(&snapshot, "api"),
            repo_named(&snapshot, "web"),
            repo_named(&snapshot, "solo"),
        );
        let snapshot = service.create_workspace("acme", &[api, web]).unwrap();
        let acme = snapshot.selected_workspace_id.unwrap();
        let worktree = snapshot.selected_worktree_id.unwrap();
        let snapshot = service
            .create_session(api, worktree, None, ProviderKind::Fake)
            .unwrap();
        let chat = snapshot.selected_session_id.unwrap();
        assert_eq!(snapshot.sessions[0].workspace_id, Some(acme));

        let looking = service.select_repository(web).unwrap();
        assert_eq!(looking.selected_repository_id, Some(web));
        assert_eq!(looking.selected_workspace_id, Some(acme));
        assert_eq!(
            looking.selected_session_id,
            Some(chat),
            "the chat stays open"
        );
        assert_eq!(
            looking.sessions.len(),
            1,
            "the chat belongs to the workspace"
        );
        assert_eq!(looking.worktrees[0].repository_id, web);

        let back = service.select_workspace(acme).unwrap();
        assert_eq!(
            back.selected_repository_id,
            Some(web),
            "the workspace remembers its focus"
        );

        let other = service.select_repository(solo).unwrap();
        assert_ne!(other.selected_workspace_id, Some(acme));
        assert!(other.sessions.is_empty());
        assert_eq!(
            other.selected_session_id, None,
            "another workspace has other chats"
        );
    }

    #[test]
    fn a_chat_remembers_one_worktree_of_every_other_member() {
        let git = git_with(&["/w/api", "/w/web"]);
        let store = FakeStore::healthy();
        let service = WorkspaceService {
            git: &git,
            store: &store,
        };
        service.open_repository("/w/api").unwrap();
        let snapshot = service.open_repository("/w/web").unwrap();
        let (api, web) = (repo_named(&snapshot, "api"), repo_named(&snapshot, "web"));
        let snapshot = service.create_workspace("acme", &[api, web]).unwrap();
        let worktree = snapshot.selected_worktree_id.unwrap();
        let snapshot = service
            .create_session(api, worktree, None, ProviderKind::Fake)
            .unwrap();
        let session = snapshot.selected_session_id.unwrap();
        let others = store.session_worktrees(session).unwrap();
        assert_eq!(others.len(), 1);
        assert_eq!(
            store
                .get_worktree(others[0])
                .unwrap()
                .unwrap()
                .repository_id,
            web
        );

        let roots = session_roots(&store, &snapshot.sessions[0]).unwrap();
        let names: Vec<&str> = roots.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(
            names,
            ["api", "web"],
            "the chat's own repository comes first"
        );
    }

    #[test]
    fn a_workspace_with_chats_is_not_deleted_and_an_empty_one_is() {
        let git = git_with(&["/w/api", "/w/web"]);
        let store = FakeStore::healthy();
        let service = WorkspaceService {
            git: &git,
            store: &store,
        };
        service.open_repository("/w/api").unwrap();
        let snapshot = service.open_repository("/w/web").unwrap();
        let (api, web) = (repo_named(&snapshot, "api"), repo_named(&snapshot, "web"));
        let snapshot = service.create_workspace("acme", &[api, web]).unwrap();
        let acme = snapshot.selected_workspace_id.unwrap();
        let worktree = snapshot.selected_worktree_id.unwrap();
        service
            .create_session(api, worktree, None, ProviderKind::Fake)
            .unwrap();
        let refused = service.delete_workspace(acme).unwrap_err();
        assert!(refused.message.contains("1 chat"), "{}", refused.message);

        let empty = service.create_workspace("temp", &[web]).unwrap();
        let temp = empty.selected_workspace_id.unwrap();
        let after = service.delete_workspace(temp).unwrap();
        assert!(after.workspaces.iter().all(|item| item.id != temp));
        assert_ne!(after.selected_workspace_id, Some(temp));
        assert_eq!(after.repositories.len(), 2, "the repositories stay known");
    }

    fn probe(head: &str, index: &str) -> FilesProbe {
        FilesProbe {
            head: head.into(),
            index: index.into(),
        }
    }

    #[test]
    fn the_status_is_read_only_when_something_moved_or_it_is_time_and_only_news_is_reported() {
        let root = PathBuf::from("/tmp/ataraxia-files");
        let git = FakeGit::with_repo(
            root.clone(),
            vec![WorktreeInfo {
                path: root.clone(),
                branch: Some("main".into()),
                head: None,
            }],
        );
        let mut store = FakeStore::default();
        store.healthy = true;
        let service = WorkspaceService {
            git: &git,
            store: &store,
        };
        let id = service.open_repository(&root).unwrap().selected_worktree_id;
        let id = id.unwrap();
        *git.files.lock().unwrap() = (probe("main c1", "i1"), "s1".into());
        let mut seen = HashMap::new();

        // The first look only learns.
        assert_eq!(service.follow_files(&mut seen, false).unwrap(), None);
        let learned = git.status_reads();

        // Nothing moved and it is not time: no process, no news.
        assert_eq!(service.follow_files(&mut seen, false).unwrap(), None);
        assert_eq!(git.status_reads(), learned);
        // It is time and nothing changed: the status is read, and it says nothing new.
        assert_eq!(service.follow_files(&mut seen, true).unwrap(), None);
        assert_eq!(git.status_reads(), learned + 1);

        // The index moved (`git rm`, `stash`): the status is read at once and it differs.
        *git.files.lock().unwrap() = (probe("main c1", "i2"), "s2".into());
        assert_eq!(service.follow_files(&mut seen, false).unwrap(), Some(id));
        assert_eq!(git.status_reads(), learned + 2);
        assert_eq!(service.follow_files(&mut seen, true).unwrap(), None);

        // The index touched by another tool (a refresh) with the same status is not news.
        *git.files.lock().unwrap() = (probe("main c1", "i3"), "s2".into());
        assert_eq!(service.follow_files(&mut seen, false).unwrap(), None);

        // A commit that moved HEAD (a `pull`) is news even when the status stays clean.
        *git.files.lock().unwrap() = (probe("main c2", "i3"), "s2".into());
        assert_eq!(service.follow_files(&mut seen, false).unwrap(), Some(id));
        assert_eq!(service.follow_files(&mut seen, false).unwrap(), None);

        // A file changed by a program that never touches git shows on the next status read.
        *git.files.lock().unwrap() = (probe("main c2", "i3"), "s3".into());
        assert_eq!(service.follow_files(&mut seen, false).unwrap(), None);
        assert_eq!(service.follow_files(&mut seen, true).unwrap(), Some(id));

        // Only the worktree on screen is watched: with none selected, nothing is kept.
        store.set_preference(PREF_SELECTED_WORKTREE, "").unwrap();
        assert_eq!(service.follow_files(&mut seen, true).unwrap(), None);
        assert!(seen.is_empty());
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
        fn files_removed_added_renamed_or_changed_outside_the_app_are_followed() {
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
            let mut seen = HashMap::new();
            // Every look reads the status here, as the app does every few seconds.
            let news = |seen: &mut HashMap<WorktreeId, FilesSeen>| {
                service.follow_files(seen, true).unwrap() == Some(id)
            };

            // Learning, then quiet.
            assert!(!news(&mut seen));
            assert!(!news(&mut seen));

            // `git rm` in a terminal.
            git(&repo, &["rm", "-q", "a.txt"]);
            assert!(news(&mut seen));
            assert!(!news(&mut seen));
            // `git stash` brings it back.
            git(&repo, &["stash", "-q"]);
            assert!(news(&mut seen));
            assert!(repo.join("a.txt").exists());
            // `git checkout` of another branch: files and HEAD both move.
            git(&repo, &["checkout", "-q", "feature/b"]);
            assert!(news(&mut seen));
            assert!(!news(&mut seen));
            // A fast-forward `pull`: the status stays clean, only HEAD moves.
            git(&repo, &["checkout", "-q", "main"]);
            assert!(news(&mut seen));
            git(&repo, &["merge", "-q", "--ff-only", "feature/b"]);
            assert!(news(&mut seen), "a fast-forward changes the files");
            assert_eq!(
                std::fs::read_to_string(repo.join("a.txt")).unwrap(),
                "changed on b\n"
            );
            // A plain file made, renamed and deleted with no git at all.
            std::fs::write(repo.join("new.txt"), "x\n").unwrap();
            assert!(news(&mut seen));
            std::fs::rename(repo.join("new.txt"), repo.join("renamed.txt")).unwrap();
            assert!(news(&mut seen));
            std::fs::remove_file(repo.join("renamed.txt")).unwrap();
            assert!(news(&mut seen));
            // Editing a file that was already modified still counts.
            std::fs::write(repo.join("a.txt"), "first edit\n").unwrap();
            assert!(news(&mut seen));
            std::thread::sleep(std::time::Duration::from_millis(20));
            std::fs::write(repo.join("a.txt"), "second edit\n").unwrap();
            assert!(news(&mut seen));
            assert!(!news(&mut seen));
            // The worktree of another branch is followed as well once it is the one on screen,
            // through its own `.git` file.
            let other_id = service
                .bootstrap()
                .unwrap()
                .worktrees
                .into_iter()
                .find(|w| w.path.canonicalize().ok() == other.canonicalize().ok())
                .unwrap()
                .id;
            service.select_worktree(other_id).unwrap();
            assert_eq!(service.follow_files(&mut seen, true).unwrap(), None);
            std::fs::write(other.join("a.txt"), "edited over there\n").unwrap();
            assert_eq!(
                service.follow_files(&mut seen, true).unwrap(),
                Some(other_id)
            );
            let _ = std::fs::remove_dir_all(repo.parent().unwrap());
        }

        #[test]
        fn looking_at_the_files_never_rewrites_the_index() {
            let (repo, _other, store) = setup();
            let service = WorkspaceService {
                git: &GitCli,
                store: &store,
            };
            service.open_repository(&repo).unwrap();
            let mut seen = HashMap::new();
            // A touched file makes the index stale, which a plain `git status` would refresh.
            std::thread::sleep(std::time::Duration::from_millis(20));
            std::fs::write(repo.join("a.txt"), "base\n").unwrap();
            let index = repo.join(".git/index");
            let before = std::fs::metadata(&index).unwrap().modified().unwrap();
            for _ in 0..3 {
                service.follow_files(&mut seen, true).unwrap();
            }
            assert_eq!(
                std::fs::metadata(&index).unwrap().modified().unwrap(),
                before
            );
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
