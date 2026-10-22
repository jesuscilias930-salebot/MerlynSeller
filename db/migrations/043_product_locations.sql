-- Ubicación física de cada producto (variante) de Control de ventas en bodega.
CREATE TABLE product_locations (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id integer NOT NULL CHECK (product_id > 0),
  rack text CHECK (rack IS NULL OR char_length(rack) BETWEEN 1 AND 30),
  level text CHECK (level IS NULL OR char_length(level) BETWEEN 1 AND 30),
  side text CHECK (side IS NULL OR char_length(side) BETWEEN 1 AND 30),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, product_id),
  CHECK (rack IS NOT NULL OR level IS NOT NULL OR side IS NOT NULL)
);
