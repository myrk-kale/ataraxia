-- Ataraxia workspace provenance
CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  root TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE worktrees (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  branch TEXT,
  head TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repository_id, path)
);

CREATE TABLE chat_sessions (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_opened_at TEXT
);

CREATE TABLE app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX idx_worktrees_repository_id ON worktrees(repository_id);
CREATE INDEX idx_sessions_repository_id ON chat_sessions(repository_id);
CREATE INDEX idx_sessions_worktree_id ON chat_sessions(worktree_id);
