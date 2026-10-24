-- Prendas tomadas temporalmente del almacén (exhibición, fotos, préstamo…).
-- Es solo un registro: no modifica la existencia de Control de ventas.
CREATE TABLE inventory_loans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id integer NOT NULL CHECK (product_id > 0),
  -- Nombre con color y talla al momento de registrarla, para listarla sin consultar Control.
  product_name text NOT NULL CHECK (char_length(product_name) BETWEEN 1 AND 200),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 100000),
  location text NOT NULL CHECK (char_length(location) BETWEEN 1 AND 80),
  taken_by text CHECK (taken_by IS NULL OR char_length(taken_by) BETWEEN 1 AND 60),
  return_date date,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 300),
  status text NOT NULL DEFAULT 'out' CHECK (status IN ('out', 'returned')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  returned_at timestamptz
);
CREATE INDEX inventory_loans_open_idx ON inventory_loans (organization_id, product_id) WHERE status = 'out';
