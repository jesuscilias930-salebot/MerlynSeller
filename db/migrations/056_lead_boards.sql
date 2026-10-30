-- Multi dashboard: cada columna del tablero pertenece a un dashboard (producto + zona).
-- El chat queda en el dashboard de su columna; las columnas actuales pasan al dashboard «Principal».
CREATE TABLE IF NOT EXISTS lead_boards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  product text CHECK (product IS NULL OR char_length(product) <= 80),
  zone text CHECK (zone IS NULL OR char_length(zone) <= 80),
  position integer NOT NULL DEFAULT 0,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
CREATE UNIQUE INDEX IF NOT EXISTS lead_boards_one_default ON lead_boards (organization_id) WHERE is_default;

INSERT INTO lead_boards (organization_id, name, position, is_default)
SELECT id, 'Principal', 0, true FROM organizations
ON CONFLICT DO NOTHING;

ALTER TABLE lead_columns ADD COLUMN IF NOT EXISTS board_id uuid REFERENCES lead_boards(id) ON DELETE CASCADE;
UPDATE lead_columns column_row SET board_id = board.id
FROM lead_boards board
WHERE board.organization_id = column_row.organization_id AND board.is_default AND column_row.board_id IS NULL;
ALTER TABLE lead_columns ALTER COLUMN board_id SET NOT NULL;

-- El nombre de columna ahora es único dentro de cada dashboard (dos dashboards pueden tener «R-HOT»).
ALTER TABLE lead_columns DROP CONSTRAINT IF EXISTS lead_columns_organization_id_name_key;
ALTER TABLE lead_columns DROP CONSTRAINT IF EXISTS lead_columns_board_id_name_key;
ALTER TABLE lead_columns ADD CONSTRAINT lead_columns_board_id_name_key UNIQUE (board_id, name);
CREATE INDEX IF NOT EXISTS lead_columns_board_idx ON lead_columns (board_id, position);
