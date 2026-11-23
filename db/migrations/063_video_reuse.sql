-- 1) Mismo archivo de video enviado otra vez: se reutiliza el que ya está en Meta (huella SHA-256 del original).
--    Meta guarda los archivos 30 días; se reutiliza hasta 25 para tener margen.
CREATE TABLE IF NOT EXISTS video_media_cache (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  media_id text NOT NULL,
  bytes integer,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, sha256)
);

-- 2) Videos guardados: se conserva el MP4 listo para WhatsApp (menos de 16 MB) para volver a subirlo
--    a Meta cuando su archivo venza, y se envían con un clic o con un botón de atajo en el chat.
CREATE TABLE IF NOT EXISTS saved_videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  filename text,
  bytes integer NOT NULL,
  file bytea NOT NULL,
  media_id text,
  media_uploaded_at timestamptz,
  chat_shortcut boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saved_videos_organization_idx ON saved_videos (organization_id, position, created_at);
