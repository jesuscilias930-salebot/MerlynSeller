-- Antes no se podía borrar una columna del tablero que se usó en una campaña de remarketing
-- (ON DELETE RESTRICT respondía con error 500). La campaña conserva el nombre de la columna.
ALTER TABLE remarketing_campaigns ADD COLUMN IF NOT EXISTS lead_column_name text;
UPDATE remarketing_campaigns campaign SET lead_column_name = column_row.name
FROM lead_columns column_row WHERE column_row.id = campaign.lead_column_id AND campaign.lead_column_name IS NULL;
ALTER TABLE remarketing_campaigns DROP CONSTRAINT IF EXISTS remarketing_campaigns_lead_column_id_fkey;
ALTER TABLE remarketing_campaigns ALTER COLUMN lead_column_id DROP NOT NULL;
ALTER TABLE remarketing_campaigns ADD CONSTRAINT remarketing_campaigns_lead_column_id_fkey
  FOREIGN KEY (lead_column_id) REFERENCES lead_columns(id) ON DELETE SET NULL;
