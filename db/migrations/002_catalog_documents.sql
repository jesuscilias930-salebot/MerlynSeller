ALTER TABLE messages ADD COLUMN media_id text;
ALTER TABLE messages ADD COLUMN filename text;

CREATE TABLE catalog_documents (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  media_id text NOT NULL,
  filename text,
  caption text,
  trigger_phrase text NOT NULL DEFAULT 'quisiera ver el catalogo',
  updated_at timestamptz NOT NULL DEFAULT now()
);
