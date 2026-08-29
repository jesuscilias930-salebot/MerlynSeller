CREATE TABLE lead_columns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  position integer NOT NULL CHECK (position >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

ALTER TABLE conversations
  ADD COLUMN lead_column_id uuid REFERENCES lead_columns(id) ON DELETE SET NULL;

CREATE INDEX conversations_lead_column_idx ON conversations (organization_id, lead_column_id, updated_at DESC);

INSERT INTO lead_columns (organization_id, name, position)
SELECT organizations.id, stages.name, stages.position
FROM organizations
CROSS JOIN (
  VALUES
    ('Primer contacto', 0),
    ('Re-Marketing', 1),
    ('Cotizacion', 2),
    ('Pendiente envio', 3)
) AS stages(name, position)
ON CONFLICT (organization_id, name) DO NOTHING;

UPDATE conversations
SET lead_column_id = (
  SELECT lead_columns.id
  FROM lead_columns
  WHERE lead_columns.organization_id = conversations.organization_id
  ORDER BY lead_columns.position ASC, lead_columns.created_at ASC
  LIMIT 1
)
WHERE lead_column_id IS NULL;
