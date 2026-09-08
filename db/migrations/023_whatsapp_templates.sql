CREATE TABLE whatsapp_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  meta_template_id text NOT NULL,
  name text NOT NULL,
  language text NOT NULL,
  status text NOT NULL,
  category text,
  components jsonb NOT NULL DEFAULT '[]'::jsonb,
  variable_mappings jsonb NOT NULL DEFAULT '[]'::jsonb,
  meta_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, meta_template_id, language)
);

CREATE INDEX whatsapp_templates_organization_status_idx
  ON whatsapp_templates (organization_id, status, updated_at DESC);
