-- Decisions are threads, like issues: they outlive the code they were opened against.
-- Who opened it: `you`, `agent` (recorded from the chat) or the provider/model that generated it.
ALTER TABLE decisions ADD COLUMN opened_by TEXT NOT NULL DEFAULT '';

-- Commits that influence a decision, linked by the reviewer or by the agent.
CREATE TABLE decision_commits (
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  rev TEXT NOT NULL,
  short TEXT NOT NULL,
  subject TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  committed_at TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  linked_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (decision_id, rev)
);
