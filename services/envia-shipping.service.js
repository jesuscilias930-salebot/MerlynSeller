const { z } = require('zod');
const db = require('../lib/db');

const environments = {
  sandbox: 'https://api-test.envia.com',
  production: 'https://api.envia.com',
};
const addressSchema = z.object({
  name: z.string().trim().min(1).max(160),
  phone: z.string().trim().min(8).max(32),
  street: z.string().trim().min(3).max(240),
  city: z.string().trim().min(2).max(120),
  state: z.string().trim().min(2).max(120),
  country: z.string().trim().length(2).transform((value) => value.toUpperCase()),
  postalCode: z.string().trim().min(3).max(12),
  district: z.string().trim().max(120).optional(),
  number: z.string().trim().max(40).optional(),
  email: z.string().trim().email().max(254).optional(),
});
const packageSchema = z.object({
  type: z.string().trim().min(1).max(40).default('box'),
  content: z.string().trim().min(1).max(240),
  amount: z.coerce.number().int().min(1).max(1000).default(1),
  declaredValue: z.coerce.number().nonnegative().max(1000000),
  lengthUnit: z.literal('CM').default('CM'),
  weightUnit: z.literal('KG').default('KG'),
  weight: z.coerce.number().positive().max(1000),
  dimensions: z.object({ length: z.coerce.number().positive().max(500), width: z.coerce.number().positive().max(500), height: z.coerce.number().positive().max(500) }),
});
const settingsSchema = z.object({
  environment: z.enum(['sandbox', 'production']).optional(),
  origin: addressSchema,
  defaultPackage: packageSchema.optional(),
});
const shippingInputSchema = z.object({
  conversationId: z.string().uuid().optional(),
  saleExternalId: z.union([z.string().trim().min(1).max(120), z.number().int().positive()]).optional(),
  destination: addressSchema,
  packages: z.array(packageSchema).min(1).max(20),
  carrier: z.string().trim().min(1).max(80),
  service: z.string().trim().min(1).max(120).optional(),
  type: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
  settings: z.object({ printFormat: z.string().trim().max(20).optional(), printSize: z.string().trim().max(20).optional(), currency: z.string().trim().length(3).optional(), comments: z.string().trim().max(500).optional() }).optional(),
});

const fail = (status, message) => { const error = new Error(message); error.status = status; return error; };
const parse = (schema, input) => { const result = schema.safeParse(input); if (!result.success) throw fail(400, result.error.issues[0].message); return result.data; };

const token = () => {
  if (!process.env.ENVIA_TOKEN) throw fail(503, 'Envia no está configurado. Agrega ENVIA_TOKEN al entorno del backend.');
  return process.env.ENVIA_TOKEN;
};
const request = async (environment, path, body) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.ENVIA_REQUEST_TIMEOUT_MS || 15000));
  try {
    const response = await fetch(`${environments[environment]}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal,
    });
    const raw = await response.text();
    let data; try { data = raw ? JSON.parse(raw) : {}; } catch { data = { message: raw }; }
    if (!response.ok) throw fail(response.status >= 400 && response.status < 500 ? response.status : 502, data.message || data.error || 'Envia no pudo procesar la solicitud');
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw fail(504, 'Envia tardó demasiado en responder');
    throw error;
  } finally { clearTimeout(timeout); }
};

const currentSettings = async (organizationId) => {
  const result = await db.query('SELECT environment, origin, default_package AS "defaultPackage" FROM envia_shipping_settings WHERE organization_id=$1', [organizationId]);
  return result.rows[0] || { environment: 'sandbox', origin: {}, defaultPackage: {} };
};
exports.getSettings = async (organizationId) => ({ ...(await currentSettings(organizationId)), tokenConfigured: Boolean(process.env.ENVIA_TOKEN) });
exports.saveSettings = async (organizationId, input) => {
  const data = parse(settingsSchema, input);
  const current = await currentSettings(organizationId);
  const environment = data.environment || current.environment;
  const result = await db.query(`INSERT INTO envia_shipping_settings (organization_id, environment, origin, default_package)
    VALUES ($1,$2,$3::jsonb,$4::jsonb)
    ON CONFLICT (organization_id) DO UPDATE SET environment=EXCLUDED.environment, origin=EXCLUDED.origin, default_package=EXCLUDED.default_package, updated_at=now()
    RETURNING environment, origin, default_package AS "defaultPackage"`, [organizationId, environment, JSON.stringify(data.origin), JSON.stringify(data.defaultPackage || current.defaultPackage || {})]);
  return { ...result.rows[0], tokenConfigured: Boolean(process.env.ENVIA_TOKEN) };
};
const payloadFor = (settings, data, includePrintSettings) => ({
  origin: settings.origin, destination: data.destination, packages: data.packages,
  shipment: { type: data.type, carrier: data.carrier, ...(data.service ? { service: data.service } : {}) },
  settings: { ...(data.settings || {}), ...(includePrintSettings ? {} : {}) },
});
exports.quote = async (organizationId, input) => {
  const data = parse(shippingInputSchema, input);
  const settings = await currentSettings(organizationId);
  if (!settings.origin?.name) throw fail(400, 'Configura primero la dirección de origen de Envia');
  const response = await request(settings.environment, '/ship/rate/', payloadFor(settings, data, false));
  return { environment: settings.environment, rates: Array.isArray(response.data) ? response.data : [], raw: response };
};
exports.generate = async (organizationId, input) => {
  const data = parse(shippingInputSchema, input);
  if (!data.service) throw fail(400, 'Selecciona un servicio de envío antes de generar la guía');
  const settings = await currentSettings(organizationId);
  if (!settings.origin?.name) throw fail(400, 'Configura primero la dirección de origen de Envia');
  const printSettings = { ...(data.settings || {}), printFormat: data.settings?.printFormat || 'PDF', printSize: data.settings?.printSize || 'STOCK_4X6' };
  const response = await request(settings.environment, '/ship/generate/', payloadFor(settings, { ...data, settings: printSettings }, true));
  const created = Array.isArray(response.data) ? response.data[0] : (response.data || response);
  const trackingNumber = created?.tracking_number || created?.trackingNumber || created?.track_number || null;
  const labelUrl = created?.label || created?.label_url || created?.labelUrl || null;
  const result = await db.query(`INSERT INTO shipments (organization_id, conversation_id, sale_external_id, carrier, service, tracking_number, label_url, shipment_status, status_description, price, currency, origin, destination, packages, envia_response)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'created',NULL,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb)
    RETURNING id, conversation_id AS "conversationId", sale_external_id AS "saleExternalId", carrier, service, tracking_number AS "trackingNumber", label_url AS "labelUrl", shipment_status AS status, price, currency, created_at AS "createdAt"`,
  [organizationId, data.conversationId || null, data.saleExternalId ? String(data.saleExternalId) : null, data.carrier, data.service, trackingNumber, labelUrl, created?.totalPrice || created?.price || null, created?.currency || data.settings?.currency || null, JSON.stringify(settings.origin), JSON.stringify(data.destination), JSON.stringify(data.packages), JSON.stringify(response)]);
  return result.rows[0];
};
exports.list = async (organizationId, conversationId) => (await db.query(`SELECT id, conversation_id AS "conversationId", sale_external_id AS "saleExternalId", carrier, service, tracking_number AS "trackingNumber", label_url AS "labelUrl", shipment_status AS status, status_description AS "statusDescription", price, currency, destination, created_at AS "createdAt", updated_at AS "updatedAt" FROM shipments WHERE organization_id=$1 AND ($2::uuid IS NULL OR conversation_id=$2) ORDER BY created_at DESC`, [organizationId, conversationId || null])).rows;
