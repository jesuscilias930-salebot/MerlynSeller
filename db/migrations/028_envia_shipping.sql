CREATE TABLE envia_shipping_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  environment text NOT NULL DEFAULT 'sandbox' CHECK (environment IN ('sandbox', 'production')),
  origin jsonb NOT NULL DEFAULT '{}'::jsonb,
  default_package jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  sale_external_id text,
  carrier text NOT NULL,
  service text NOT NULL,
  tracking_number text,
  label_url text,
  shipment_status text NOT NULL DEFAULT 'created',
  status_description text,
  price numeric(12,2),
  currency text,
  origin jsonb NOT NULL,
  destination jsonb NOT NULL,
  packages jsonb NOT NULL,
  envia_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, tracking_number)
);

CREATE INDEX shipments_organization_created_idx ON shipments (organization_id, created_at DESC);
CREATE INDEX shipments_conversation_idx ON shipments (conversation_id) WHERE conversation_id IS NOT NULL;
