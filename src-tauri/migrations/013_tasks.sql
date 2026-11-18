-- The developer's task list. `number` is what is said in a chat ("#12"); AUTOINCREMENT keeps it
-- from being handed out again after a task is deleted.
CREATE TABLE tasks (
    number INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
