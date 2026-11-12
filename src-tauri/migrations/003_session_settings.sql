-- Per-chat model and reasoning-effort overrides. NULL means "use the provider default".
ALTER TABLE chat_sessions ADD COLUMN model TEXT;
ALTER TABLE chat_sessions ADD COLUMN effort TEXT;
