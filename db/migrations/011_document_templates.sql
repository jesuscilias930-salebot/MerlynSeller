CREATE TABLE document_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  media_id text NOT NULL,
  filename text NOT NULL,
  caption text,
  is_catalog boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, media_id)
);

CREATE UNIQUE INDEX document_templates_one_catalog_per_organization
  ON document_templates (organization_id) WHERE is_catalog;

INSERT INTO document_templates (organization_id, media_id, filename, caption, is_catalog)
SELECT organization_id, media_id, COALESCE(filename, 'Catálogo'), caption, true
FROM catalog_documents
ON CONFLICT (organization_id, media_id) DO UPDATE SET
  filename = EXCLUDED.filename,
  caption = EXCLUDED.caption,
  is_catalog = true,
  updated_at = now();
