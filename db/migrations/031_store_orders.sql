CREATE TABLE IF NOT EXISTS store_orders (
 organization_id uuid NOT NULL REFERENCES organizations(id),
 order_id uuid NOT NULL,
 conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (organization_id,order_id)
);
CREATE INDEX IF NOT EXISTS store_orders_chat_idx ON store_orders(organization_id,conversation_id);
