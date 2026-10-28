-- Messenger e Instagram Direct en el mismo inbox que WhatsApp.
-- Los contactos de esos canales se identifican por su PSID/IGSID (external_id);
-- phone_number guarda «fb:<PSID>» o «ig:<IGSID>» para conservar la llave única existente.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp', 'messenger', 'instagram')),
  ADD COLUMN IF NOT EXISTS external_id text,
  ADD COLUMN IF NOT EXISTS username text;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_channel_external_idx
  ON contacts (organization_id, channel, external_id) WHERE external_id IS NOT NULL;
