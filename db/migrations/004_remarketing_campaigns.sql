CREATE TABLE remarketing_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_column_id uuid NOT NULL REFERENCES lead_columns(id) ON DELETE RESTRICT,
  body text,
  image_media_id text,
  image_filename text,
  recipient_count integer NOT NULL DEFAULT 0 CHECK (recipient_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (body IS NOT NULL OR image_media_id IS NOT NULL)
);

ALTER TABLE messages
  ADD COLUMN remarketing_campaign_id uuid REFERENCES remarketing_campaigns(id) ON DELETE SET NULL;

CREATE INDEX messages_remarketing_campaign_idx ON messages (remarketing_campaign_id);
