-- Separate checkout settings from ad-hoc CRM shipping quotes.
CREATE TABLE store_shipping_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  origin jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Preserve the origin previously used by checkout at migration time only.
INSERT INTO store_shipping_settings (organization_id, environment, origin)
SELECT organization_id, environment, origin FROM envia_shipping_settings
WHERE coalesce(origin->>'name', '') <> ''
ON CONFLICT (organization_id) DO NOTHING;
