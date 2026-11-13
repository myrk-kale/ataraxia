-- A workspace is a named set of repositories. Chats belong to a workspace, and the agent of a
-- chat sees every member.
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE workspace_repositories (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, repository_id)
);
CREATE INDEX idx_workspace_repositories_repository ON workspace_repositories(repository_id);

ALTER TABLE chat_sessions ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL;
CREATE INDEX idx_sessions_workspace_id ON chat_sessions(workspace_id);

-- The worktrees a chat sees besides its own (one per other member, fixed when the chat is made).
CREATE TABLE session_worktrees (
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, worktree_id)
);

-- Every repository that exists becomes a workspace of one, under the same id and name, and its
-- chats move into it.
INSERT INTO workspaces (id, name, created_at, updated_at)
  SELECT id, name, created_at, updated_at FROM repositories;
INSERT INTO workspace_repositories (workspace_id, repository_id, position)
  SELECT id, id, 0 FROM repositories;
UPDATE chat_sessions SET workspace_id = repository_id;
