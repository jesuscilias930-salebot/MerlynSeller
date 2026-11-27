-- ⏳ Sin respuesta → mover: si el último mensaje del chat es nuestro y pasa la espera configurada,
-- el lead se mueve a otra columna sin enviar nada.
CREATE TABLE IF NOT EXISTS column_timeouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  column_id uuid NOT NULL REFERENCES lead_columns(id) ON DELETE CASCADE,
  target_column_id uuid NOT NULL REFERENCES lead_columns(id) ON DELETE CASCADE,
  wait_minutes integer NOT NULL CHECK (wait_minutes BETWEEN 30 AND 129600),
  is_active boolean NOT NULL DEFAULT true,
  -- La espera cuenta desde lo último entre: nuestro último mensaje, la llegada a la columna y la
  -- activación (al activarla no se mueven de golpe los chats viejos).
  activated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (column_id),
  CHECK (column_id <> target_column_id)
);

-- Cuándo llegó el lead a su columna actual (cualquier forma de moverlo: a mano, escenario, regla…).
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS lead_column_entered_at timestamptz NOT NULL DEFAULT now();
CREATE OR REPLACE FUNCTION set_lead_column_entered_at() RETURNS trigger AS $$
BEGIN
  IF NEW.lead_column_id IS DISTINCT FROM OLD.lead_column_id THEN
    NEW.lead_column_entered_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS conversations_lead_column_entered_at ON conversations;
CREATE TRIGGER conversations_lead_column_entered_at BEFORE UPDATE OF lead_column_id ON conversations
  FOR EACH ROW EXECUTE FUNCTION set_lead_column_entered_at();
