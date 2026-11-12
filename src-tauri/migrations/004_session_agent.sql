-- Named agent a chat runs as (a Claude/OpenCode agent definition). NULL means the default agent.
ALTER TABLE chat_sessions ADD COLUMN agent TEXT;
