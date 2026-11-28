-- The workbench: a board the agents of a workspace share. A chat joins it on purpose (a row in
-- `workbench_members`); what it posts is an entry. Entries are kept by workspace, not by chat, so
-- the history reads right after a chat is renamed or deleted (`author_label` is the name it had).
CREATE TABLE workbench_members (
    session_id TEXT PRIMARY KEY REFERENCES chat_sessions(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    joined_at TEXT NOT NULL,
    -- Repository id to the commit its worktree was at when the chat joined: what the agent changed
    -- is measured from there.
    base_json TEXT NOT NULL DEFAULT '{}',
    -- The newest entry its agent was handed, so it is only told what it has not seen.
    cursor INTEGER NOT NULL DEFAULT 0,
    seen_at TEXT,
    -- Whether its agent has been told how the board works.
    briefed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_workbench_members_workspace ON workbench_members(workspace_id);

CREATE TABLE workbench_entries (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    -- NULL is the developer.
    author_session_id TEXT,
    author_label TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active',
    topic TEXT,
    text TEXT NOT NULL,
    why TEXT,
    paths_json TEXT NOT NULL DEFAULT '[]',
    anchor_json TEXT,
    -- 'developer', or the id of the agent it is for; NULL is everyone.
    to_target TEXT,
    reply_to TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_workbench_entries_workspace ON workbench_entries(workspace_id, seq);
CREATE INDEX idx_workbench_entries_topic ON workbench_entries(workspace_id, topic);
