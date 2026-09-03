-- Product-price examples belong to a dedicated text automation, not to the
-- catalog document action. Removing these ambiguous defaults prevents old
-- installations from classifying every phrase containing "precio" as catalog.
UPDATE automation_intents
SET examples = (
  SELECT COALESCE(jsonb_agg(item.value), '[]'::jsonb)
  FROM jsonb_array_elements_text(examples) AS item(value)
  WHERE lower(item.value) NOT LIKE '%precio%'
),
updated_at = now()
WHERE key = 'catalogo'
  AND action = 'send_catalog'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(examples) AS item(value)
    WHERE lower(item.value) LIKE '%precio%'
  );
