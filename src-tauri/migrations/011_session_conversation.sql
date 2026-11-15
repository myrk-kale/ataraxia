-- The conversation the harness keeps for a chat (its own session or thread id), so reopening the
-- chat under the same model picks it up again. NULL means the next start begins a new one.
ALTER TABLE chat_sessions ADD COLUMN agent_ref TEXT;
