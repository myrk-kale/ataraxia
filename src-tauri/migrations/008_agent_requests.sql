-- Who wrote a review comment: `you`, or `agent` when it was asked for in the chat or in BTW.
ALTER TABLE review_comments ADD COLUMN author TEXT NOT NULL DEFAULT 'you';

-- A priority someone set by hand (or asked an agent to set) on a unit of the review queue. The
-- queue itself is computed from the code, so this is a layer on top of it, keyed by what the unit
-- is (file and name) and not by its rank, which moves.
CREATE TABLE unit_priority (
  checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  score INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  set_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (checkpoint_id, path, name)
);
