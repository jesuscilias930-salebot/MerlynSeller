CREATE TABLE automation_scenarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key)
);

CREATE TABLE conversation_scenario_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  scenario_key text NOT NULL,
  step text NOT NULL,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX conversation_active_scenario_idx
  ON conversation_scenario_states(conversation_id)
  WHERE completed_at IS NULL;
CREATE INDEX automation_scenarios_organization_idx ON automation_scenarios(organization_id);

INSERT INTO automation_scenarios (organization_id, key, name, config)
SELECT id, 'catalogo_anuncio', 'Catálogo — lead de anuncio',
  '{
    "catalogCaption":"Claro, acá lo tienes. Por favor confírmame si puedes abrirlo sin problema.",
    "goalQuestion":"¡Perfecto! ¿Estás buscando emprender o surtir tu negocio?",
    "entrepreneurQuestion":"¿Te gustaría que te recomiende alguna caja emprendedora junto con las ganancias aproximadas que puedes obtener de cada una?",
    "closingMessage":"Claro, quedo atento a cualquier duda.",
    "completionColumnId":""
  }'::jsonb
FROM organizations
ON CONFLICT (organization_id, key) DO NOTHING;

INSERT INTO automation_scenarios (organization_id, key, name, config)
SELECT id, 'envios_nacionales', 'Envíos a toda la República',
  '{
    "shippingMessage":"Sí, claro. Soy de Orizaba, Veracruz, pero hago envíos a toda la República. Además cuento con un grupo de WhatsApp de clientes para que hagas tu compra de manera tranquila.",
    "catalogQuestion":"¿Te gustaría que te envíe el catálogo?",
    "catalogCaption":"Claro, acá lo tienes.",
    "goalQuestion":"¿Estás buscando emprender o surtir tu negocio?",
    "entrepreneurQuestion":"¿Te gustaría que te recomiende alguna caja emprendedora junto con las ganancias aproximadas que puedes obtener de cada una?",
    "evidence":[],
    "boxes":[
      {"title":"Caja emprendedora 1","description":"Configura aquí la mercancía, precio y ganancia aproximada."},
      {"title":"Caja emprendedora 2","description":"Configura aquí la mercancía, precio y ganancia aproximada."},
      {"title":"Caja emprendedora 3","description":"Configura aquí la mercancía, precio y ganancia aproximada."}
    ]
  }'::jsonb
FROM organizations
ON CONFLICT (organization_id, key) DO NOTHING;
