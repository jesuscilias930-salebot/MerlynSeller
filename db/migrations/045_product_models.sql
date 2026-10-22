-- Modelo que agrupa variantes (color/talla) de productos de Control de ventas.
ALTER TABLE product_details ADD COLUMN model text CHECK (model IS NULL OR char_length(model) BETWEEN 1 AND 80);
CREATE INDEX product_details_model_idx ON product_details (organization_id, lower(model)) WHERE model IS NOT NULL;
