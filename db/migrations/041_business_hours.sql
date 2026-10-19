CREATE TABLE business_hours_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Último aviso fuera de horario enviado a la conversación (uno por periodo cerrado).
ALTER TABLE conversations ADD COLUMN after_hours_notified_at timestamptz;
