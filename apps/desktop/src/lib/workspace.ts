export type RepositoryId = string;
export type WorkspaceId = string;
export type WorktreeId = string;
export type SessionId = string;

export type ProviderKind = "fake" | "opencode" | "claude" | "codex" | "cursor";

export type SessionStatus =
  | "idle"
  | "starting"
  | "ready"
  | "working"
  | "waiting-permission"
  | "stopping"
  | "stopped"
  | "failed";

export type Repository = {
  id: RepositoryId;
  root: string;
  name: string;
  created_at: string;
  updated_at: string;
};

/** A named set of repositories opened together; the agent of a chat sees every member. */
export type Workspace = {
  id: WorkspaceId;
  name: string;
  /** Members, in the order the user arranged them. */
  repository_ids: RepositoryId[];
  created_at: string;
  updated_at: string;
};

export type Worktree = {
  id: WorktreeId;
  repository_id: RepositoryId;
  path: string;
  branch: string | null;
  head: string | null;
  created_at: string;
  updated_at: string;
};

export type ChatSession = {
  id: SessionId;
  workspace_id?: WorkspaceId | null;
  /** The chat's own repository: where its agent starts. */
  repository_id: RepositoryId;
  worktree_id: WorktreeId;
  provider: ProviderKind;
  title: string;
  status: SessionStatus;
  model: string | null;
  effort: string | null;
  agent: string | null;
  /** Launch profile (account) the chat starts its harness with; `null` is the default way. */
  profile?: string | null;
  /** `chat` for the user's chats; hidden children (BTW, discussions) use other kinds. */
  kind?: "chat" | "btw" | "delegate" | "decision" | "analysis";
  parent_session_id?: SessionId | null;
  created_at: string;
  updated_at: string;
  last_opened_at: string | null;
};

export type WorkspaceSnapshot = {
  repositories: Repository[];
  workspaces: Workspace[];
  selected_workspace_id: WorkspaceId | null;
  /** The repository in focus: the one Code, the terminal and the branch selector show. */
  selected_repository_id: RepositoryId | null;
  worktrees: Worktree[];
  selected_worktree_id: WorktreeId | null;
  sessions: ChatSession[];
  selected_session_id: SessionId | null;
  /** The chats of every other workspace, so the list shows them all grouped by workspace. */
  other_sessions?: ChatSession[];
};

/** A local branch as the selector shows it. */
export type BranchView = {
  name: string;
  current: boolean;
  /** The worktree that already has it open, when it is one of the repository's. */
  worktree_id: WorktreeId | null;
};

export type BranchList = {
  branches: BranchView[];
  /** Remote branches (`origin/feature`) with no local branch of the same name yet. */
  remotes: string[];
  workspace: WorkspaceSnapshot;
};

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export function emptyWorkspace(): WorkspaceSnapshot {
  return {
    repositories: [],
    workspaces: [],
    selected_workspace_id: null,
    selected_repository_id: null,
    worktrees: [],
    selected_worktree_id: null,
    sessions: [],
    selected_session_id: null,
    other_sessions: [],
  };
}

export function workspaceBootstrap() {
  return invoke<WorkspaceSnapshot>("workspace_bootstrap");
}

export function workspaceOpenRepository(path: string) {
  return invoke<WorkspaceSnapshot>("workspace_open_repository", { path });
}

/** Records the repository at a folder without selecting it; the workspace dialog adds folders this way. */
export function workspaceRegisterRepository(path: string) {
  return invoke<Repository>("workspace_register_repository", { path });
}

export function workspaceSelectWorkspace(workspaceId: WorkspaceId) {
  return invoke<WorkspaceSnapshot>("workspace_select_workspace", { workspaceId });
}

export function workspacePreviousWorkspace() {
  return invoke<WorkspaceSnapshot>("workspace_previous_workspace");
}

export function workspaceCreateWorkspace(name: string, repositoryIds: RepositoryId[]) {
  return invoke<WorkspaceSnapshot>("workspace_create_workspace", { name, repositoryIds });
}

export function workspaceUpdateWorkspace(workspaceId: WorkspaceId, name: string, repositoryIds: RepositoryId[]) {
  return invoke<WorkspaceSnapshot>("workspace_update_workspace", { workspaceId, name, repositoryIds });
}

export function workspaceDeleteWorkspace(workspaceId: WorkspaceId) {
  return invoke<WorkspaceSnapshot>("workspace_delete_workspace", { workspaceId });
}

export function workspaceSelectRepository(repositoryId: RepositoryId) {
  return invoke<WorkspaceSnapshot>("workspace_select_repository", {
    repositoryId,
  });
}

export function workspaceSelectWorktree(worktreeId: WorktreeId) {
  return invoke<WorkspaceSnapshot>("workspace_select_worktree", {
    worktreeId,
  });
}

/** `like`: the chat on screen, whose model and effort the new one keeps (same provider only). */
export function workspaceCreateSession(
  repositoryId: RepositoryId,
  worktreeId: WorktreeId,
  title?: string,
  provider?: ProviderKind,
  like?: SessionId | null,
) {
  return invoke<WorkspaceSnapshot>("workspace_create_session", {
    repositoryId,
    worktreeId,
    title: title ?? null,
    provider: provider ?? null,
    like: like ?? null,
  });
}

export function workspaceOpenSession(sessionId: SessionId) {
  return invoke<WorkspaceSnapshot>("workspace_open_session", { sessionId });
}

/** Deletes a chat for good: its messages, checkpoints, decisions and diagrams. The code stays. */
export function workspaceDeleteSession(sessionId: SessionId) {
  return invoke<WorkspaceSnapshot>("workspace_delete_session", { sessionId });
}

/** Every local branch, read from git each time. */
export function workspaceListBranches(worktreeId: WorktreeId) {
  return invoke<BranchList>("workspace_list_branches", { worktreeId });
}

/** Tries to move to a branch; when git refuses, the rejection says why and nothing changed. */
export function workspaceSelectBranch(worktreeId: WorktreeId, name: string) {
  return invoke<WorkspaceSnapshot>("workspace_select_branch", { worktreeId, name });
}

/**
 * Goes to a branch by name, wherever it is: local, on the remote, or new on the remote (fetched for).
 * `repository` names the member of the workspace it belongs to, when a link said so.
 */
export function workspaceGoToBranch(worktreeId: WorktreeId, name: string, repository: string | null = null) {
  return invoke<WorkspaceSnapshot>("workspace_go_to_branch", { worktreeId, name, repository });
}

/** Brings the remotes up to date and lists the branches again; a failure says what git said. */
export function workspaceFetchBranches(worktreeId: WorktreeId) {
  return invoke<BranchList>("workspace_fetch_branches", { worktreeId });
}

/** Checks out a remote branch (`origin/feature`) as a local branch that tracks it. */
export function workspaceCheckoutRemoteBranch(worktreeId: WorktreeId, remote: string) {
  return invoke<WorkspaceSnapshot>("workspace_checkout_remote_branch", { worktreeId, remote });
}

/** Makes a branch from another branch, a remote one, a tag or a commit, and moves to it. */
export function workspaceCreateBranch(worktreeId: WorktreeId, name: string, base: string) {
  return invoke<WorkspaceSnapshot>("workspace_create_branch", { worktreeId, name, base });
}

/**
 * The files of the selected worktree changed under the app (a removal, a checkout or a pull in a
 * terminal, a file deleted by another program). Resolves to the function that stops listening.
 */
export function listenFilesChanged(handler: (worktreeId: WorktreeId) => void): Promise<UnlistenFn> {
  return listen<{ worktreeId: WorktreeId }>("worktree://files-changed", (event) => handler(event.payload.worktreeId));
}
