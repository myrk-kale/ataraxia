-- The launch profile a chat starts its harness with (an id from the stored profiles). NULL means
-- the default way. It is chosen per chat; the profile a harness had "active" before this became
-- per chat is copied into the chats of that harness by the migration code.
ALTER TABLE chat_sessions ADD COLUMN profile TEXT;
