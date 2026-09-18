CREATE TABLE IF NOT EXISTS integration_features (
 organization_id uuid PRIMARY KEY REFERENCES organizations(id),
 envia_environment text NOT NULL DEFAULT 'sandbox' CHECK (envia_environment IN ('sandbox','production')),
 stripe_environment text NOT NULL DEFAULT 'sandbox' CHECK (stripe_environment IN ('sandbox','production')),
 updated_at timestamptz NOT NULL DEFAULT now()
);
