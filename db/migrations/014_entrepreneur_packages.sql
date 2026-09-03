CREATE TABLE entrepreneur_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  media_id text NOT NULL,
  filename text,
  caption text CHECK (caption IS NULL OR char_length(caption) <= 1024),
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX entrepreneur_packages_organization_position_idx
  ON entrepreneur_packages (organization_id, position, created_at);
