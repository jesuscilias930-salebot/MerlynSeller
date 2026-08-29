CREATE TABLE remarketing_presets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100),
  body text,
  image_media_id text,
  image_filename text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name),
  CHECK (body IS NOT NULL OR image_media_id IS NOT NULL)
);

CREATE INDEX remarketing_presets_organization_idx ON remarketing_presets (organization_id, updated_at DESC);
