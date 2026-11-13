-- Hidden sessions (BTW investigations, decision discussions, analysis runs) hang off a chat.
ALTER TABLE chat_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE chat_sessions ADD COLUMN parent_session_id TEXT REFERENCES chat_sessions(id) ON DELETE CASCADE;
CREATE INDEX idx_sessions_parent ON chat_sessions(parent_session_id);

-- Subagent conversations survive an app restart.
CREATE TABLE subagents (
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  subagent_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (session_id, subagent_id)
);

-- Repository -> Worktree -> Chat Session -> Checkpoints -> Artifacts
CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  base_rev TEXT NOT NULL,
  head_rev TEXT NOT NULL,
  source TEXT NOT NULL,
  turn_id TEXT,
  files_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, seq)
);
CREATE INDEX idx_checkpoints_session ON checkpoints(session_id, seq);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  -- One artifact per (checkpoint, kind, dedupe key): retries never duplicate it.
  dedupe_key TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  content_json TEXT NOT NULL DEFAULT '{}',
  provenance_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (checkpoint_id, kind, dedupe_key)
);
CREATE INDEX idx_artifacts_session ON artifacts(session_id, kind);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  rationale TEXT NOT NULL DEFAULT '',
  alternatives_json TEXT NOT NULL DEFAULT '[]',
  refs_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'pending',
  version INTEGER NOT NULL DEFAULT 1,
  superseded_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_decisions_session ON decisions(session_id, seq);

CREATE TABLE decision_revisions (
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (decision_id, version)
);

CREATE TABLE decision_messages (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  code_ref_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_decision_messages ON decision_messages(decision_id, created_at);

-- Judgment of an implementation (one file of a checkpoint), independent from decisions.
CREATE TABLE review_marks (
  checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (checkpoint_id, path)
);

CREATE TABLE review_comments (
  id TEXT PRIMARY KEY,
  checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  line INTEGER,
  side TEXT NOT NULL DEFAULT 'head',
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_review_comments ON review_comments(checkpoint_id, path);

CREATE TABLE btw_tasks (
  id TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  question TEXT NOT NULL,
  context_json TEXT NOT NULL,
  context_text TEXT NOT NULL,
  return_policy TEXT NOT NULL,
  summary TEXT,
  returned_at TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_btw_parent ON btw_tasks(parent_session_id, created_at);

CREATE TABLE flow_presets (
  id TEXT PRIMARY KEY,
  repository_id TEXT REFERENCES repositories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Audit trail of the MCP server.
CREATE TABLE mcp_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  tool TEXT NOT NULL,
  scope TEXT,
  write INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT
);
