-- Dashboard padre / hijos: un dashboard de campaña (hijo) puede pertenecer a uno general (padre,
-- p. ej. «Calcetines»). El padre muestra una columna por hijo con todos sus leads. Un solo nivel.
ALTER TABLE lead_boards ADD COLUMN IF NOT EXISTS parent_board_id uuid REFERENCES lead_boards(id) ON DELETE SET NULL;
ALTER TABLE lead_boards DROP CONSTRAINT IF EXISTS lead_boards_parent_not_self;
ALTER TABLE lead_boards ADD CONSTRAINT lead_boards_parent_not_self CHECK (parent_board_id IS NULL OR parent_board_id <> id);
CREATE INDEX IF NOT EXISTS lead_boards_parent_idx ON lead_boards (parent_board_id) WHERE parent_board_id IS NOT NULL;
