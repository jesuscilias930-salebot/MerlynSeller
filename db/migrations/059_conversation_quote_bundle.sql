-- Paquete (bundle de Control) que el cotizador del chat tiene seleccionado por defecto.
-- Lo fija el escenario que se activó con el mensaje del cliente y se puede cambiar a mano desde el Inbox.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS quote_bundle_id text,
  ADD COLUMN IF NOT EXISTS quote_bundle_name text,
  ADD COLUMN IF NOT EXISTS quote_bundle_updated_at timestamptz;
