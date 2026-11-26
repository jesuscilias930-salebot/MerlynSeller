-- chatAd: según el primer mensaje del cliente (p. ej. el texto prellenado de un anuncio), el chat
-- muestra botones de acceso rápido con imágenes elegidas de los conjuntos guardados y un texto.
CREATE TABLE IF NOT EXISTS chat_ads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  trigger_examples jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- [{ label, text?, imageIds: [uuid] }]
  buttons jsonb NOT NULL DEFAULT '[]'::jsonb,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_ads_organization_idx ON chat_ads (organization_id, position);
