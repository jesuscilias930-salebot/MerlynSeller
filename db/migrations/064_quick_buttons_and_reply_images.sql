-- Respuestas rápidas con imágenes: fotos de «Imágenes guardadas» que se envían junto con el texto.
ALTER TABLE quick_replies ADD COLUMN IF NOT EXISTS image_ids uuid[] NOT NULL DEFAULT '{}';

-- Botones rápidos del chat (debajo del cuadro de texto): invitación con enlace y 5 conjuntos de imágenes.
CREATE TABLE IF NOT EXISTS chat_quick_buttons (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
