-- Agrupación de escenarios por campaña (config.campaign). Los escenarios de la Caja Emprendedora de
-- 120 pares (CE120 y su remarketing) arrancan en «Campaña 120»; los demás quedan sin campaña.
UPDATE automation_scenarios
SET config = COALESCE(config, '{}'::jsonb) || jsonb_build_object('campaign', 'Campaña 120')
WHERE (name ILIKE 'CE120%' OR name ILIKE 'Remarketing 120%')
  AND NULLIF(btrim(COALESCE(config->>'campaign', '')), '') IS NULL;
