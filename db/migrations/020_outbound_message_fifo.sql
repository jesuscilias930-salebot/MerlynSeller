-- Every outbound message receives a stable position inside its conversation.
-- The worker uses it to preserve WhatsApp delivery order while still sending
-- different conversations in parallel.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS outbound_sequence bigint;

WITH numbered_messages AS (
  SELECT id, row_number() OVER (PARTITION BY conversation_id ORDER BY created_at, id) AS sequence
  FROM messages
  WHERE direction = 'outbound'
)
UPDATE messages AS message
SET outbound_sequence = numbered_messages.sequence
FROM numbered_messages
WHERE message.id = numbered_messages.id
  AND message.outbound_sequence IS NULL;

CREATE OR REPLACE FUNCTION assign_outbound_message_sequence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.direction = 'outbound' AND NEW.outbound_sequence IS NULL THEN
    -- Serializes only inserts for the same conversation. Hash collisions merely
    -- cause harmless extra serialization, never an incorrect sequence.
    PERFORM pg_advisory_xact_lock(hashtext(NEW.conversation_id::text));
    SELECT COALESCE(MAX(outbound_sequence), 0) + 1
      INTO NEW.outbound_sequence
      FROM messages
     WHERE conversation_id = NEW.conversation_id
       AND direction = 'outbound';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS messages_assign_outbound_sequence ON messages;
CREATE TRIGGER messages_assign_outbound_sequence
BEFORE INSERT ON messages
FOR EACH ROW
EXECUTE FUNCTION assign_outbound_message_sequence();

CREATE UNIQUE INDEX IF NOT EXISTS messages_outbound_sequence_idx
  ON messages (conversation_id, outbound_sequence)
  WHERE direction = 'outbound';

CREATE INDEX IF NOT EXISTS messages_pending_outbound_fifo_idx
  ON messages (conversation_id, outbound_sequence)
  WHERE direction = 'outbound' AND status = 'pending';
