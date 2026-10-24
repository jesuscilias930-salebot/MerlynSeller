-- Venta pendiente de pago ligada a cada recordatorio y envío automático con
-- plantilla oficial de WhatsApp.
CREATE TABLE pending_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  contact_name text NOT NULL CHECK (char_length(contact_name) BETWEEN 1 AND 120),
  phone text NOT NULL CHECK (phone ~ '^[0-9]{8,15}$'),
  items jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) <= 30),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'cancelled')),
  amount numeric(12, 2) CHECK (amount IS NULL OR amount > 0),
  payment_method text CHECK (payment_method IS NULL OR payment_method IN ('cash', 'transfer', 'card', 'deposit', 'other')),
  paid_items jsonb CHECK (paid_items IS NULL OR jsonb_typeof(paid_items) = 'array'),
  control_sale_id integer,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'paid') = (amount IS NOT NULL AND control_sale_id IS NOT NULL))
);
CREATE INDEX pending_sales_org_status_idx ON pending_sales (organization_id, status, created_at DESC);
CREATE UNIQUE INDEX pending_sales_control_sale_idx ON pending_sales (organization_id, control_sale_id) WHERE control_sale_id IS NOT NULL;

ALTER TABLE reminders
  ADD COLUMN sale_id uuid REFERENCES pending_sales(id) ON DELETE SET NULL,
  ADD COLUMN send_mode text NOT NULL DEFAULT 'manual' CHECK (send_mode IN ('manual', 'template')),
  ADD COLUMN template_id uuid REFERENCES whatsapp_templates(id) ON DELETE SET NULL,
  ADD COLUMN template_mappings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(template_mappings) = 'array'),
  ADD COLUMN agreed_date date,
  ADD COLUMN conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  ADD COLUMN sent_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  ADD COLUMN send_error text CHECK (send_error IS NULL OR char_length(send_error) <= 1000);
ALTER TABLE reminders DROP CONSTRAINT IF EXISTS reminders_status_check;
ALTER TABLE reminders ADD CONSTRAINT reminders_status_check CHECK (status IN ('scheduled', 'done', 'cancelled'));
CREATE INDEX reminders_sale_idx ON reminders (sale_id) WHERE sale_id IS NOT NULL;
CREATE INDEX reminders_sent_message_idx ON reminders (sent_message_id) WHERE sent_message_id IS NOT NULL;
