-- Cada plantilla o mensaje guardado puede pertenecer a una columna de un tablero:
-- desde esa columna se envía con un clic.
ALTER TABLE remarketing_move_rules ADD COLUMN IF NOT EXISTS home_column_id uuid REFERENCES lead_columns(id) ON DELETE SET NULL;
