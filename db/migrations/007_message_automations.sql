ALTER TABLE conversations ADD COLUMN auto_reply_enabled boolean NOT NULL DEFAULT true;

CREATE TABLE automation_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  response_body text,
  action text NOT NULL DEFAULT 'text' CHECK (action IN ('text', 'send_catalog')),
  examples jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key),
  CHECK ((action = 'send_catalog') OR char_length(trim(coalesce(response_body, ''))) > 0)
);

CREATE TABLE automation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  inbound_provider_message_id text NOT NULL UNIQUE,
  detected_intents jsonb NOT NULL DEFAULT '[]'::jsonb,
  source text NOT NULL CHECK (source IN ('rules', 'ai', 'none')),
  confidence numeric(4,3),
  outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX automation_intents_organization_id_idx ON automation_intents(organization_id);
CREATE INDEX automation_events_conversation_id_idx ON automation_events(conversation_id, created_at DESC);

INSERT INTO automation_intents (organization_id, key, name, action, examples, is_active, priority)
SELECT id, 'catalogo', 'Enviar catálogo', 'send_catalog', '["catalogo", "mandame el catalogo", "podria enviarme su catalogo", "quiero ver el catalogo"]'::jsonb, true, 100
FROM organizations
ON CONFLICT (organization_id, key) DO NOTHING;

INSERT INTO automation_intents (organization_id, key, name, response_body, action, examples, is_active, priority)
SELECT id, 'envio', 'Información de envío', 'Configura aquí la respuesta sobre envíos antes de activar esta automatización.', 'text', '["cuanto cuesta el envio", "costo de envio", "hacen envios"]'::jsonb, false, 90
FROM organizations
ON CONFLICT (organization_id, key) DO NOTHING;

INSERT INTO automation_intents (organization_id, key, name, response_body, action, examples, is_active, priority)
SELECT id, 'minimo_compra', 'Mínimo de compra', 'Configura aquí la respuesta sobre mínimo de compra antes de activar esta automatización.', 'text', '["tienen minimo de compra", "cual es el minimo", "minimo"]'::jsonb, false, 80
FROM organizations
ON CONFLICT (organization_id, key) DO NOTHING;

INSERT INTO automation_intents (organization_id, key, name, response_body, action, examples, is_active, priority)
SELECT id, 'proceso_compra', 'Proceso de compra', 'Configura aquí la respuesta sobre el proceso de compra antes de activar esta automatización.', 'text', '["cual es el proceso de compra", "como compro", "como funciona la compra"]'::jsonb, false, 70
FROM organizations
ON CONFLICT (organization_id, key) DO NOTHING;
