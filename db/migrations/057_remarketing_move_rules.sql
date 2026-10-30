-- Remarketing → mover a columna. Por plantilla oficial o mensaje guardado:
-- al enviarse, mover a una columna; si el lead responde, mover a otra (y fijarlo ahí).
CREATE TABLE IF NOT EXISTS remarketing_move_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_id uuid REFERENCES whatsapp_templates(id) ON DELETE CASCADE,
  preset_id uuid REFERENCES remarketing_presets(id) ON DELETE CASCADE,
  after_send_column_id uuid REFERENCES lead_columns(id) ON DELETE SET NULL,
  on_reply_column_id uuid REFERENCES lead_columns(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((template_id IS NULL) <> (preset_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS remarketing_move_rules_template ON remarketing_move_rules (organization_id, template_id) WHERE template_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS remarketing_move_rules_preset ON remarketing_move_rules (organization_id, preset_id) WHERE preset_id IS NOT NULL;

-- Cada campaña guarda la configuración con la que se envió.
ALTER TABLE remarketing_campaigns
  ADD COLUMN IF NOT EXISTS preset_id uuid REFERENCES remarketing_presets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS after_send_column_id uuid REFERENCES lead_columns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS on_reply_column_id uuid REFERENCES lead_columns(id) ON DELETE SET NULL;

-- Solo la primera respuesta a una campaña mueve al lead.
CREATE TABLE IF NOT EXISTS remarketing_reply_moves (
  campaign_id uuid NOT NULL REFERENCES remarketing_campaigns(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, conversation_id)
);
