-- Citas de entrega y la venta en persona registrada al entregar.
CREATE TABLE delivery_appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  customer_name text NOT NULL CHECK (char_length(customer_name) BETWEEN 1 AND 120),
  customer_phone text CHECK (customer_phone IS NULL OR char_length(customer_phone) <= 20),
  location text NOT NULL CHECK (char_length(location) BETWEEN 1 AND 300),
  scheduled_at timestamptz NOT NULL,
  products jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(products) = 'array' AND jsonb_array_length(products) <= 30),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'delivered', 'cancelled')),
  sale_amount numeric(12, 2) CHECK (sale_amount IS NULL OR sale_amount > 0),
  sale_payment_method text CHECK (sale_payment_method IS NULL OR sale_payment_method IN ('cash', 'transfer', 'card', 'deposit', 'other')),
  sale_items jsonb CHECK (sale_items IS NULL OR jsonb_typeof(sale_items) = 'array'),
  control_sale_id integer,
  sale_recorded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((sale_recorded_at IS NULL) = (sale_amount IS NULL))
);

CREATE INDEX delivery_appointments_org_schedule_idx ON delivery_appointments (organization_id, scheduled_at);
CREATE INDEX delivery_appointments_conversation_idx ON delivery_appointments (organization_id, conversation_id) WHERE conversation_id IS NOT NULL;
CREATE UNIQUE INDEX delivery_appointments_control_sale_idx ON delivery_appointments (organization_id, control_sale_id) WHERE control_sale_id IS NOT NULL;
