-- Seguimientos automáticos por columna: si el cliente deja de responder, se le escribe después de un
-- tiempo (hasta 3 pasos). Se detiene en cuanto el cliente contesta.
CREATE TABLE IF NOT EXISTS follow_up_sequences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  column_id uuid NOT NULL REFERENCES lead_columns(id) ON DELETE CASCADE,
  is_active boolean NOT NULL DEFAULT false,
  -- Solo se siguen chats con actividad posterior a la activación (no se escribe a todo el historial).
  activated_at timestamptz,
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  final_column_id uuid REFERENCES lead_columns(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (column_id)
);

-- Avance del seguimiento de cada chat. Un «ciclo» empieza con el último mensaje del cliente:
-- si vuelve a escribir, el ciclo se reinicia desde el paso 1.
CREATE TABLE IF NOT EXISTS conversation_follow_ups (
  conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sequence_id uuid NOT NULL REFERENCES follow_up_sequences(id) ON DELETE CASCADE,
  cycle_inbound_at timestamptz,
  step_index integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'stopped')),
  stopped_reason text,
  last_step_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversation_follow_ups_sequence_idx ON conversation_follow_ups (sequence_id, status);
