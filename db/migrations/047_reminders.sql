-- Recordatorios para escribirle a un cliente y el chat interno (no conectado a WhatsApp)
-- donde llegan cuando es la hora.
CREATE TABLE reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_name text NOT NULL CHECK (char_length(contact_name) BETWEEN 1 AND 120),
  phone text NOT NULL CHECK (phone ~ '^[0-9]{8,15}$'),
  products jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(products) = 'array' AND jsonb_array_length(products) <= 30),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  remind_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'done')),
  notified_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reminders_org_time_idx ON reminders (organization_id, remind_at);
CREATE INDEX reminders_due_idx ON reminders (remind_at) WHERE status = 'scheduled' AND notified_at IS NULL;

CREATE TABLE internal_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('reminder', 'note')),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  reminder_id uuid REFERENCES reminders(id) ON DELETE SET NULL,
  payload jsonb,
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX internal_messages_org_time_idx ON internal_messages (organization_id, created_at DESC);
CREATE INDEX internal_messages_unread_idx ON internal_messages (organization_id) WHERE read_at IS NULL;
