-- Datos adicionales de productos de Control de ventas que viven en MerlynSeller.
CREATE TABLE product_details (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id integer NOT NULL CHECK (product_id > 0),
  color text CHECK (color IS NULL OR char_length(color) BETWEEN 1 AND 40),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, product_id)
);
