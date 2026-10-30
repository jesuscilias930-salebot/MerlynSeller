-- Reglas «mover a columna» por lada: la regla aplica solo a números cuya lada esté en la lista.
-- Una regla puede no tener frases (cualquier mensaje) si tiene ladas.
ALTER TABLE column_rules ADD COLUMN IF NOT EXISTS area_codes text[] NOT NULL DEFAULT '{}';
ALTER TABLE column_rules DROP CONSTRAINT IF EXISTS column_rules_phrases_check;
ALTER TABLE column_rules DROP CONSTRAINT IF EXISTS column_rules_phrases_or_area_codes;
ALTER TABLE column_rules ADD CONSTRAINT column_rules_phrases_or_area_codes CHECK (
  cardinality(phrases) <= 50 AND cardinality(area_codes) <= 100
  AND (cardinality(phrases) > 0 OR cardinality(area_codes) > 0)
);
