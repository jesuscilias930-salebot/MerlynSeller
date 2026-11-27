-- Reglas «mover a columna» por anuncio: si el cliente llegó desde un anuncio (clic a WhatsApp) cuyo título,
-- texto o id contiene ad_match, se mueve con su primer mensaje, diga lo que diga.
ALTER TABLE column_rules ADD COLUMN IF NOT EXISTS ad_match text;
ALTER TABLE column_rules DROP CONSTRAINT IF EXISTS column_rules_phrases_or_area_codes;
ALTER TABLE column_rules ADD CONSTRAINT column_rules_phrases_or_area_codes CHECK (
  cardinality(phrases) <= 50 AND cardinality(area_codes) <= 100
  AND (cardinality(phrases) > 0 OR cardinality(area_codes) > 0 OR NULLIF(btrim(COALESCE(ad_match, '')), '') IS NOT NULL)
);
