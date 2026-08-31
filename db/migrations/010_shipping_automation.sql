ALTER TABLE automation_intents
  DROP CONSTRAINT IF EXISTS automation_intents_action_check;

ALTER TABLE automation_intents
  ADD CONSTRAINT automation_intents_action_check
  CHECK (action IN ('text', 'send_catalog', 'send_shipping_info'));

UPDATE automation_intents
SET
  name = 'Costo de envío',
  action = 'send_shipping_info',
  response_body = 'El envío depende de la ciudad a donde se mande la mercancía y de la cantidad que desee adquirir. Si gusta, por favor indíqueme:\n\n• Mercancía que desea adquirir\n• Código postal\n• Calle\n• Colonia\n\nY le cotizo su envío.',
  examples = '["costo de envio", "cuanto cuesta el envio", "cuanto sale el envio", "precio del envio", "hacen envios", "envio a mi ciudad"]'::jsonb,
  is_active = true,
  priority = GREATEST(priority, 95),
  updated_at = now()
WHERE key = 'envio';
