export type RepositoryId = string;
export type WorktreeId = string;
export type SessionId = string;

export type ProviderKind = "fake" | "opencode" | "claude" | "codex";

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
  repository_id: RepositoryId;
  worktree_id: WorktreeId;
  provider: ProviderKind;
  title: string;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  last_opened_at: string | null;
};

export type WorkspaceSnapshot = {
  repositories: Repository[];
  selected_repository_id: RepositoryId | null;
  worktrees: Worktree[];
  selected_worktree_id: WorktreeId | null;
  sessions: ChatSession[];
  selected_session_id: SessionId | null;
};

import { invoke } from "@tauri-apps/api/core";

export function emptyWorkspace(): WorkspaceSnapshot {
  return {
    repositories: [],
    selected_repository_id: null,
    worktrees: [],
    selected_worktree_id: null,
    sessions: [],
    selected_session_id: null,
  };
}

export function workspaceBootstrap() {
  return invoke<WorkspaceSnapshot>("workspace_bootstrap");
}

export function workspaceOpenRepository(path: string) {
  return invoke<WorkspaceSnapshot>("workspace_open_repository", { path });
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

export function workspaceCreateSession(
  repositoryId: RepositoryId,
  worktreeId: WorktreeId,
  title?: string,
  provider?: ProviderKind,
) {
  return invoke<WorkspaceSnapshot>("workspace_create_session", {
    repositoryId,
    worktreeId,
    title: title ?? null,
    provider: provider ?? null,
  });
}

export function workspaceOpenSession(sessionId: SessionId) {
  return invoke<WorkspaceSnapshot>("workspace_open_session", { sessionId });
}
