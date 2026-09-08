ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS message_metadata jsonb;

CREATE INDEX IF NOT EXISTS messages_metadata_idx
  ON messages USING gin (message_metadata)
  WHERE message_metadata IS NOT NULL;
