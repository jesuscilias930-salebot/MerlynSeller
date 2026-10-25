-- Cómo se agrupan las categorías de Control en la página de productos de la tienda.
-- Varias categorías con la misma sección se muestran juntas (p. ej. dos tipos de Essentials).
CREATE TABLE store_category_sections (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  category_id integer NOT NULL CHECK (category_id > 0),
  category_name text NOT NULL CHECK (char_length(category_name) BETWEEN 1 AND 120),
  section text NOT NULL CHECK (char_length(section) BETWEEN 1 AND 60),
  position integer NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 999),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, category_id)
);
