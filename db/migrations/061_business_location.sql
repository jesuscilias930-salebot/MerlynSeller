-- Ubicación fija del negocio (bodega) que se envía a los clientes desde el chat con un clic.
CREATE TABLE IF NOT EXISTS business_locations (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  name text,
  address text,
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  updated_at timestamptz NOT NULL DEFAULT now()
);
