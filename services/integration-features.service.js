const db = require('../lib/db');
const fail = (status, message) => Object.assign(new Error(message), { status });
exports.enviaToken = environment => {
  if (environment === 'production') return process.env.ENVIA_TOKEN_PRODUCTION || '';
  return process.env.ENVIA_TOKEN_SANDBOX || process.env.ENVIA_TOKEN || '';
};
exports.get = async organizationId => {
  const { rows } = await db.query('SELECT envia_environment AS envia, stripe_environment AS stripe, card_payments_enabled AS "cardPaymentsEnabled", meta_events_enabled AS "metaEventsEnabled" FROM integration_features WHERE organization_id=$1', [organizationId]);
  return rows[0] || { envia: 'sandbox', stripe: 'sandbox', cardPaymentsEnabled: true, metaEventsEnabled: false };
};
exports.stripeReadiness = async () => {
  const url = new URL(process.env.SOCK_CONTROL_URL || 'http://localhost:8080');
  if (url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw fail(503, 'SOCK_CONTROL_URL inválida');
  const secret = process.env.STORE_SHIPPING_SECRET || '';
  if (secret.length < 32) throw fail(503, 'Configura STORE_SHIPPING_SECRET');
  try {
    const response = await fetch(new URL('/internal/features/stripe-readiness', url), { headers: { 'X-Store-Shipping-Secret': secret }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error();
    const data = await response.json();
    return { sandbox: data.sandbox === true, production: data.production === true };
  } catch { throw fail(503, 'No se pudo verificar Stripe en SockControl. Revisa su URL, conexión y secreto interno.'); }
};
exports.save = async (organizationId, input) => {
  if (input?.service === 'metaEvents') {
    if (typeof input.enabled !== 'boolean') throw fail(400, 'Indica si los eventos de Meta están habilitados');
    await db.query(`INSERT INTO integration_features (organization_id, meta_events_enabled) VALUES ($1,$2)
      ON CONFLICT (organization_id) DO UPDATE SET meta_events_enabled=EXCLUDED.meta_events_enabled, updated_at=now()`, [organizationId, input.enabled]);
    console.info(JSON.stringify({ level: 'info', message: 'Store Meta events changed', organizationId, enabled: input.enabled }));
    return exports.get(organizationId);
  }
  if (input?.service === 'cardPayments') {
    if (typeof input.enabled !== 'boolean') throw fail(400, 'Indica si los pagos con tarjeta están habilitados');
    await db.query(`INSERT INTO integration_features (organization_id, card_payments_enabled) VALUES ($1,$2)
      ON CONFLICT (organization_id) DO UPDATE SET card_payments_enabled=EXCLUDED.card_payments_enabled, updated_at=now()`, [organizationId, input.enabled]);
    console.info(JSON.stringify({ level: 'info', message: 'Store card payments changed', organizationId, enabled: input.enabled }));
    return exports.get(organizationId);
  }
  const { service, environment, confirmProduction } = input || {};
  if (!['envia', 'stripe'].includes(service) || !['sandbox', 'production'].includes(environment)) throw fail(400, 'Selecciona un servicio y ambiente válidos');
  if (environment === 'production' && confirmProduction !== true) throw fail(400, 'Confirma el uso de producción');
  const ready = service === 'envia' ? Boolean(exports.enviaToken(environment)) : (await exports.stripeReadiness())[environment];
  if (!ready) throw fail(400, 'Faltan las credenciales del ambiente seleccionado en el servidor');
  // Column name comes exclusively from the allowlist above, never arbitrary input.
  const column = service === 'envia' ? 'envia_environment' : 'stripe_environment';
  await db.query(`INSERT INTO integration_features (organization_id, ${column}) VALUES ($1,$2)
    ON CONFLICT (organization_id) DO UPDATE SET ${column}=EXCLUDED.${column}, updated_at=now()`, [organizationId, environment]);
  console.info(JSON.stringify({ level: 'info', message: 'Integration environment changed', organizationId, service, environment }));
  return exports.get(organizationId);
};
