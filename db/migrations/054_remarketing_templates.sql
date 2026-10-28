-- Remarketing masivo con una plantilla oficial aprobada por Meta (llega aunque pasen las 24 h).
ALTER TABLE remarketing_campaigns
  ADD COLUMN IF NOT EXISTS template_id uuid,
  ADD COLUMN IF NOT EXISTS template_name text;
