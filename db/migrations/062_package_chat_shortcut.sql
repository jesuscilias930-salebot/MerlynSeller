-- Conjunto de imágenes guardadas que aparece como botón de atajo debajo del cuadro de texto del chat.
ALTER TABLE entrepreneur_packages ADD COLUMN IF NOT EXISTS chat_shortcut boolean NOT NULL DEFAULT false;
