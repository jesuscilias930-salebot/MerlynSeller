-- Configuración única de la Campaña 120 (Merlyn Mayoreo). Solo aplica si existen estas columnas y la
-- plantilla en la base (en otras bases no hace nada).
--   Cotización      f22cd7d5-5e7d-429a-b1e9-58bca753fc46   (dashboard «Campaña 120», hijo de «Calcetines»)
--   Remarketing 1   c423c0ef-3224-4356-849a-9ef73493d502
--   Remarketing 2   8b0f6a51-39a6-4255-bee4-961bbe11e8db
--   Calcetines (padre): se identifica por su columna «Calcetines Interesados» 7ad5ae13-c3e2-4283-9f4c-6671dd1003ae
--   Descartados (Calcetines) 458e3daa-a208-42e3-b37a-7a52aa9a9be0 · plantilla remarketin120 98d67487-c504-4e29-bda1-0207d1028008

-- 1) Leads actuales de la caja de 120 (cotizador con el paquete «Caja 120», id 12) que siguen en el
--    dashboard Calcetines → Campaña 120 · Cotización. Los de Descartados se quedan donde están.
UPDATE conversations c
SET lead_column_id = 'f22cd7d5-5e7d-429a-b1e9-58bca753fc46', updated_at = now()
FROM lead_columns target
WHERE target.id = 'f22cd7d5-5e7d-429a-b1e9-58bca753fc46'
  AND c.organization_id = target.organization_id
  AND c.quote_bundle_id = '12'
  AND c.lead_column_id <> '458e3daa-a208-42e3-b37a-7a52aa9a9be0'
  AND c.lead_column_id IN (
    SELECT column_row.id FROM lead_columns column_row
    WHERE column_row.board_id = (SELECT board_id FROM lead_columns WHERE id = '7ad5ae13-c3e2-4283-9f4c-6671dd1003ae')
  );

-- 2) ⏳ Cotización: si no contestan a nuestro último mensaje en 5 horas → Remarketing 1.
INSERT INTO column_timeouts (organization_id, column_id, target_column_id, wait_minutes, is_active, activated_at)
SELECT source.organization_id, source.id, target.id, 300, true, now()
FROM lead_columns source JOIN lead_columns target ON target.id = 'c423c0ef-3224-4356-849a-9ef73493d502' AND target.organization_id = source.organization_id
WHERE source.id = 'f22cd7d5-5e7d-429a-b1e9-58bca753fc46'
ON CONFLICT (column_id) DO UPDATE SET target_column_id = EXCLUDED.target_column_id, wait_minutes = EXCLUDED.wait_minutes,
  is_active = true, activated_at = CASE WHEN column_timeouts.is_active THEN column_timeouts.activated_at ELSE now() END, updated_at = now();

-- 3) Remarketing con la plantilla remarketin120: aparece en Remarketing 1 (📣) y al enviarse mueve a
--    Remarketing 2. Las respuestas las reparten los escenarios de plantilla (Cierre / Dudas / Perdido).
INSERT INTO remarketing_move_rules (organization_id, template_id, home_column_id, after_send_column_id, on_reply_column_id)
SELECT template.organization_id, template.id, 'c423c0ef-3224-4356-849a-9ef73493d502', '8b0f6a51-39a6-4255-bee4-961bbe11e8db', NULL
FROM whatsapp_templates template
WHERE template.id = '98d67487-c504-4e29-bda1-0207d1028008'
  AND EXISTS (SELECT 1 FROM lead_columns WHERE id = '8b0f6a51-39a6-4255-bee4-961bbe11e8db' AND organization_id = template.organization_id)
ON CONFLICT (organization_id, template_id) WHERE template_id IS NOT NULL
DO UPDATE SET home_column_id = EXCLUDED.home_column_id, after_send_column_id = EXCLUDED.after_send_column_id, on_reply_column_id = NULL, updated_at = now();
