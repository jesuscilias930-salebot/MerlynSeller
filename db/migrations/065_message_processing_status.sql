-- Videos: el mensaje aparece en el chat como «processing» mientras el servidor lo convierte y lo sube a Meta
-- en segundo plano; después pasa a «pending» y el worker lo envía en su orden.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_status_check;
ALTER TABLE messages
  ADD CONSTRAINT messages_status_check
  CHECK (status IN ('pending', 'processing', 'sent', 'delivered', 'read', 'failed', 'received', 'deleted'));
