-- A checkpoint can compare any two revisions, not only the two ends of a turn.
ALTER TABLE checkpoints ADD COLUMN base_label TEXT;
ALTER TABLE checkpoints ADD COLUMN head_label TEXT;
-- 1 when the head is the live working tree (files can be edited), 0 for a fixed revision.
ALTER TABLE checkpoints ADD COLUMN head_live INTEGER NOT NULL DEFAULT 1;
