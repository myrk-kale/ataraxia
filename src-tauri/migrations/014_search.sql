CREATE TABLE search_documents (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    source_rowid INTEGER NOT NULL,
    kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    session_id TEXT,
    repository_id TEXT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    path TEXT,
    line INTEGER,
    checkpoint_id TEXT,
    UNIQUE (source, source_rowid)
);

CREATE INDEX idx_btw_session ON btw_tasks(session_id);

CREATE VIRTUAL TABLE search_fts USING fts5(
    title, body, content='search_documents', content_rowid='id',
    tokenize='unicode61 remove_diacritics 2', prefix='2 3'
);

CREATE TRIGGER search_document_insert AFTER INSERT ON search_documents BEGIN
    INSERT INTO search_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER search_document_delete AFTER DELETE ON search_documents BEGIN
    INSERT INTO search_fts(search_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;

-- Search one message at a time so snippets and navigation target the matching entry.
-- Tool payloads and internal agent runs are excluded from the user-facing index.
CREATE VIEW search_sources(source, source_rowid, kind, item_id, session_id, repository_id, title, body, path, line, checkpoint_id) AS
    SELECT 'chat_sessions', rowid, 'chat', id, id, NULL, title, '', NULL, NULL, NULL
    FROM chat_sessions WHERE kind = 'chat'
    UNION ALL
    SELECT 'chat_items', i.rowid, 'message', i.payload ->> '$.id', i.session_id, NULL, '',
           i.payload ->> '$.text', NULL, NULL, NULL
    FROM chat_items i JOIN chat_sessions s ON s.id = i.session_id
    WHERE (s.kind = 'chat' OR EXISTS (SELECT 1 FROM btw_tasks WHERE session_id = s.id))
          AND i.payload ->> '$.kind' = 'message'
          AND i.payload ->> '$.role' IN ('user', 'assistant', 'reasoning', 'system')
          AND coalesce(i.payload ->> '$.text', '') <> ''
    UNION ALL
    SELECT 'subagents', a.rowid, 'subagent', a.subagent_id, a.session_id, NULL,
           coalesce(a.payload ->> '$.title', 'Subagent'),
           coalesce((SELECT group_concat(value ->> '$.text', char(10))
                     FROM json_each(a.payload, '$.items')
                     WHERE value ->> '$.kind' = 'message'
                       AND value ->> '$.role' IN ('user', 'assistant', 'reasoning', 'system')), ''),
           NULL, NULL, NULL
    FROM subagents a JOIN chat_sessions s ON s.id = a.session_id
    WHERE s.kind = 'chat' OR EXISTS (SELECT 1 FROM btw_tasks WHERE session_id = s.id)
    UNION ALL
    SELECT 'checkpoints', rowid, 'checkpoint', id, session_id, repository_id,
           'Checkpoint #' || seq, files_json, NULL, NULL, id
    FROM checkpoints
    UNION ALL
    SELECT 'artifacts', a.rowid, a.kind, a.id, a.session_id, c.repository_id,
           CASE a.kind WHEN 'flow' THEN 'Flow diagram'
                       WHEN 'decision' THEN 'Decisions'
                       ELSE 'Review priority' END,
           coalesce(a.provenance_json ->> '$.presetName', '') || char(10) ||
           a.content_json || char(10) || coalesce(a.error, ''), NULL, NULL, c.id
    FROM artifacts a JOIN checkpoints c ON c.id = a.checkpoint_id
    UNION ALL
    SELECT 'decisions', d.rowid, 'decision_item', d.id, d.session_id, c.repository_id, d.title,
           d.summary || char(10) || d.context || char(10) || d.rationale || char(10) ||
           d.alternatives_json || char(10) || d.refs_json, NULL, NULL, c.id
    FROM decisions d JOIN checkpoints c ON c.id = d.checkpoint_id
    UNION ALL
    SELECT 'decision_messages', m.rowid, 'decision_item', d.id, d.session_id, c.repository_id, '',
           m.text, NULL, NULL, c.id
    FROM decision_messages m JOIN decisions d ON d.id = m.decision_id
                             JOIN checkpoints c ON c.id = d.checkpoint_id
    UNION ALL
    SELECT 'review_comments', r.rowid, 'review_comment', r.id, c.session_id, c.repository_id, r.path,
           r.text, r.path, r.line, c.id
    FROM review_comments r JOIN checkpoints c ON c.id = r.checkpoint_id
    UNION ALL
    SELECT 'btw_tasks', rowid, 'btw', id, parent_session_id, NULL, question, coalesce(summary, ''), NULL, NULL, NULL
    FROM btw_tasks
    UNION ALL
    SELECT 'tasks', number, 'task', CAST(number AS TEXT), NULL, NULL,
           '#' || number || ' ' || title, notes, NULL, NULL, NULL
    FROM tasks;

INSERT INTO search_documents(source, source_rowid, kind, item_id, session_id, repository_id, title, body, path, line, checkpoint_id)
SELECT * FROM search_sources;
