ALTER TABLE entrepreneur_packages ALTER COLUMN media_id DROP NOT NULL;

CREATE TABLE entrepreneur_package_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id uuid NOT NULL REFERENCES entrepreneur_packages(id) ON DELETE CASCADE,
  media_id text NOT NULL,
  filename text,
  caption text CHECK (caption IS NULL OR char_length(caption) <= 1024),
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO entrepreneur_package_images (package_id, media_id, filename, caption, position)
SELECT id, media_id, filename, caption, 0
FROM entrepreneur_packages
WHERE media_id IS NOT NULL;

CREATE INDEX entrepreneur_package_images_package_position_idx
  ON entrepreneur_package_images (package_id, position, created_at);
