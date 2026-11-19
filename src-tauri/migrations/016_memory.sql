-- What the agents remember, shared by every chat and every provider. A memory is a node of a graph:
-- its kind says what sort of knowledge it is, and `memory_links` says how two memories relate.
-- A memory does not point at the chat it came from, because chats can be deleted. `workspace_id`
-- NULL is the developer's own, global memory; otherwise it belongs to that workspace.
CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    workspace_id TEXT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    tags_json TEXT NOT NULL DEFAULT '[]',
    -- Who stood behind it: the developer said it, the agent saw it verified, or the agent inferred it.
    source TEXT NOT NULL,
    -- Who wrote it down: an agent through the tools, or the developer in Settings.
    author TEXT NOT NULL,
    expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_memories_workspace ON memories(workspace_id);

CREATE TABLE memory_links (
    from_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    to_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    relation TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (from_id, to_id, relation),
    CHECK (from_id <> to_id)
);
CREATE INDEX idx_memory_links_to ON memory_links(to_id);

-- A workspace's memories go with the workspace.
CREATE TRIGGER memories_of_deleted_workspace AFTER DELETE ON workspaces BEGIN
    DELETE FROM memories WHERE workspace_id = old.id;
END;
