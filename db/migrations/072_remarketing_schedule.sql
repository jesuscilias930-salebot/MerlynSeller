-- Horario del remarketing automático: entre «pausar» y «reanudar» no salen seguimientos ⏱ y, si se
-- activa, los envíos 📣 quedan «programados» y se mandan solos a la hora de reanudar.
CREATE TABLE IF NOT EXISTS remarketing_schedules (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  is_active boolean NOT NULL DEFAULT true,
  pause_at text NOT NULL DEFAULT '21:00' CHECK (pause_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  resume_at text NOT NULL DEFAULT '09:00' CHECK (resume_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  defer_campaigns boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- «scheduled»: mensaje de remarketing en espera de la hora de reanudar. El worker no lo toca (solo envía
-- «pending»), así que no sale aunque se le escriba al cliente en la noche.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS scheduled_for timestamptz;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_status_check;
ALTER TABLE messages
  ADD CONSTRAINT messages_status_check
  CHECK (status IN ('pending', 'processing', 'scheduled', 'sent', 'delivered', 'read', 'failed', 'received', 'deleted'));
CREATE INDEX IF NOT EXISTS messages_scheduled_idx ON messages (scheduled_for) WHERE status = 'scheduled';
