-- Fotos del E-commerce (SockControl) ya subidas a WhatsApp: se reutiliza su media_id
-- al enviar «producto con tallas» desde chats y escenarios en lugar de subirlas cada vez.
CREATE TABLE IF NOT EXISTS product_photo_media (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  photo_id bigint NOT NULL CHECK (photo_id > 0),
  media_id text NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, photo_id)
);
