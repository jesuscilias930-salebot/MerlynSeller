-- «Si llega este mensaje, mover a esta columna». El lead queda fijado en esa columna:
-- las automatizaciones no lo mueven hasta que una persona lo mueva a mano.
CREATE TABLE column_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  phrases text[] NOT NULL CHECK (cardinality(phrases) BETWEEN 1 AND 50),
  match_mode text NOT NULL DEFAULT 'contains' CHECK (match_mode IN ('contains', 'exact')),
  column_id uuid NOT NULL REFERENCES lead_columns(id) ON DELETE CASCADE,
  is_active boolean NOT NULL DEFAULT true,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX column_rules_org_idx ON column_rules (organization_id, position);

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS column_pinned_at timestamptz,
  ADD COLUMN IF NOT EXISTS column_pinned_rule_id uuid REFERENCES column_rules(id) ON DELETE SET NULL;
