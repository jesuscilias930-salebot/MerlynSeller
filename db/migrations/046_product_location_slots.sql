-- Ubicación por talla y/o color dentro de un mismo producto de Control de ventas
-- (cuando el producto tiene un solo stock pero se guarda separado en bodega).
CREATE TABLE product_location_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id integer NOT NULL CHECK (product_id > 0),
  size text CHECK (size IS NULL OR char_length(size) BETWEEN 1 AND 40),
  color text CHECK (color IS NULL OR char_length(color) BETWEEN 1 AND 40),
  quantity integer CHECK (quantity IS NULL OR quantity BETWEEN 0 AND 1000000000),
  rack text CHECK (rack IS NULL OR char_length(rack) BETWEEN 1 AND 30),
  level text CHECK (level IS NULL OR char_length(level) BETWEEN 1 AND 30),
  side text CHECK (side IS NULL OR char_length(side) BETWEEN 1 AND 30),
  position smallint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (size IS NOT NULL OR color IS NOT NULL),
  CHECK (rack IS NOT NULL OR level IS NOT NULL OR side IS NOT NULL)
);
CREATE UNIQUE INDEX product_location_slots_unique_idx
  ON product_location_slots (organization_id, product_id, lower(coalesce(size, '')), lower(coalesce(color, '')));
CREATE INDEX product_location_slots_product_idx ON product_location_slots (organization_id, product_id, position);
