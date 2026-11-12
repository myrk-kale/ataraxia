-- Persisted chat transcript, one row per ordered item (message or tool call).
CREATE TABLE chat_items (
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (session_id, position)
);
