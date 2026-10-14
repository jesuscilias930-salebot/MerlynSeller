-- PostgreSQL: run with the CRM backend migration runner (npm run migrate).
-- Do not reuse or change the number that receives checkout orders.
ALTER TABLE integration_features
  ADD COLUMN IF NOT EXISTS whatsapp_button_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS whatsapp_number varchar(15) NOT NULL DEFAULT '';
