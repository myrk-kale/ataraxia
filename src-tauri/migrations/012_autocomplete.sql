-- What the autocomplete has learned from the person's own messages: how often a word followed
-- the words before it. `scope` is `global` or the id of a chat; `context` is up to three
-- lowercase words before it, joined by a space (empty for a word on its own).
CREATE TABLE autocomplete_grams (
    scope TEXT NOT NULL,
    context TEXT NOT NULL,
    word TEXT NOT NULL,
    count INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope, context, word)
);
