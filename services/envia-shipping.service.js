const { z } = require('zod');
const { randomUUID } = require('crypto');
const db = require('../lib/db');

const environments = {
  sandbox: 'https://api-test.envia.com',
  production: 'https://api.envia.com',
};
const queryEnvironments = {
  sandbox: 'https://queries.test.envia.com',
  production: 'https://queries.envia.com',
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
const savedAddressSchema = z.object({
  kind: z.enum(['origin', 'destination']),
  name: z.string().trim().min(1).max(100),
  address: addressSchema,
});
const savedPackageSchema = z.object({
  name: z.string().trim().min(1).max(100),
  package: packageSchema,
});
const shippingInputSchema = z.object({
  conversationId: z.string().uuid().optional(),
  saleExternalId: z.union([z.string().trim().min(1).max(120), z.number().int().positive()]).optional(),
  destination: addressSchema,
  packages: z.array(packageSchema).min(1).max(20),
  // A carrier is required only when purchasing a selected label. Quotes can
  // intentionally omit it so we compare every carrier enabled in Envia.
  carrier: z.string().trim().min(1).max(80).optional(),
  service: z.string().trim().min(1).max(120).optional(),
  type: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
  settings: z.object({ printFormat: z.string().trim().max(20).optional(), printSize: z.string().trim().max(20).optional(), currency: z.string().trim().length(3).optional(), comments: z.string().trim().max(500).optional() }).optional(),
});

const fail = (status, message) => { const error = new Error(message); error.status = status; return error; };
const parse = (schema, input) => { const result = schema.safeParse(input); if (!result.success) throw fail(400, result.error.issues[0].message); return result.data; };

const token = () => {
  if (!process.env.ENVIA_TOKEN) {
    console.warn(JSON.stringify({ level: 'warn', message: 'Envia request blocked: ENVIA_TOKEN is missing' }));
    throw fail(503, 'Envia no está configurado. Agrega ENVIA_TOKEN al entorno del backend.');
  }
  return process.env.ENVIA_TOKEN;
};
const request = async (environment, path, body, context = {}) => {
  const requestId = randomUUID();
  const apiToken = token();
  console.log(JSON.stringify({
    level: 'info', message: 'Envia API request started', requestId, environment, path,
    organizationId: context.organizationId, carrier: context.carrier, service: context.service || null,
    destinationCountry: context.destinationCountry, destinationPostalCode: context.destinationPostalCode,
    packageCount: context.packageCount, tokenConfigured: Boolean(apiToken),
  }));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.ENVIA_REQUEST_TIMEOUT_MS || 15000));
  try {
    const baseUrl = context.api === 'queries' ? queryEnvironments[environment] : environments[environment];
    const response = await fetch(`${baseUrl}${path}`, {
      method: context.method || 'POST', headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal,
    });
    const raw = await response.text();
    let data; try { data = raw ? JSON.parse(raw) : {}; } catch { data = { message: raw }; }
    if (!response.ok) {
      const detail = String(data.message || data.error || 'Envia no pudo procesar la solicitud').slice(0, 500);
      console.warn(JSON.stringify({ level: 'warn', message: 'Envia API request rejected', requestId, environment, path, status: response.status, detail }));
      throw fail(response.status >= 400 && response.status < 500 ? response.status : 502, detail);
    }
    console.log(JSON.stringify({ level: 'info', message: 'Envia API request completed', requestId, environment, path, status: response.status }));
    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      console.warn(JSON.stringify({ level: 'warn', message: 'Envia API request timed out', requestId, environment, path }));
      throw fail(504, 'Envia tardó demasiado en responder');
    }
    if (!error.status) console.error(JSON.stringify({ level: 'error', message: 'Envia API request failed before response', requestId, environment, path, errorType: error.name, errorMessage: String(error.message || 'Unknown error').slice(0, 500) }));
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
  console.log(JSON.stringify({ level: 'info', message: 'Envia shipping settings saved', organizationId, environment, originCountry: data.origin.country, originPostalCode: data.origin.postalCode, tokenConfigured: Boolean(process.env.ENVIA_TOKEN) }));
  return { ...result.rows[0], tokenConfigured: Boolean(process.env.ENVIA_TOKEN) };
};
exports.listSaved = async (organizationId) => {
  const [addresses, packages] = await Promise.all([
    db.query(`SELECT id, kind, name, address, created_at AS "createdAt", updated_at AS "updatedAt" FROM envia_saved_addresses WHERE organization_id=$1 ORDER BY kind, created_at DESC`, [organizationId]),
    db.query(`SELECT id, name, package, created_at AS "createdAt", updated_at AS "updatedAt" FROM envia_saved_packages WHERE organization_id=$1 ORDER BY created_at DESC`, [organizationId]),
  ]);
  return { addresses: addresses.rows, packages: packages.rows };
};
exports.saveAddress = async (organizationId, input) => {
  const data = parse(savedAddressSchema, input);
  const result = await db.query(`INSERT INTO envia_saved_addresses (organization_id, kind, name, address) VALUES ($1,$2,$3,$4::jsonb) RETURNING id, kind, name, address, created_at AS "createdAt", updated_at AS "updatedAt"`, [organizationId, data.kind, data.name, JSON.stringify(data.address)]);
  console.log(JSON.stringify({ level: 'info', message: 'Envia address preset saved', organizationId, kind: data.kind, presetId: result.rows[0].id }));
  return result.rows[0];
};
exports.savePackage = async (organizationId, input) => {
  const data = parse(savedPackageSchema, input);
  const result = await db.query(`INSERT INTO envia_saved_packages (organization_id, name, package) VALUES ($1,$2,$3::jsonb) RETURNING id, name, package, created_at AS "createdAt", updated_at AS "updatedAt"`, [organizationId, data.name, JSON.stringify(data.package)]);
  console.log(JSON.stringify({ level: 'info', message: 'Envia package preset saved', organizationId, presetId: result.rows[0].id }));
  return result.rows[0];
};
exports.deleteSaved = async (organizationId, kind, id) => {
  if (!['origin', 'destination', 'package'].includes(kind)) throw fail(400, 'Tipo de registro guardado inválido');
  const table = kind === 'package' ? 'envia_saved_packages' : 'envia_saved_addresses';
  const query = kind === 'package'
    ? `DELETE FROM ${table} WHERE id=$1 AND organization_id=$2 RETURNING id`
    : `DELETE FROM ${table} WHERE id=$1 AND organization_id=$2 AND kind=$3 RETURNING id`;
  const result = await db.query(query, kind === 'package' ? [id, organizationId] : [id, organizationId, kind]);
  if (!result.rows[0]) throw fail(404, 'Registro guardado no encontrado');
  return { id };
};
exports.listCustomers = async (organizationId) => (await db.query(`
  SELECT conversation.id, contact.name, contact.phone_number AS "phoneNumber"
  FROM conversations conversation
  JOIN contacts contact ON contact.id=conversation.contact_id
  WHERE conversation.organization_id=$1
  ORDER BY contact.name NULLS LAST, conversation.updated_at DESC
`, [organizationId])).rows;
const payloadFor = (settings, data, includePrintSettings) => ({
  origin: settings.origin, destination: data.destination, packages: data.packages,
  shipment: { type: data.type, ...(data.carrier ? { carrier: data.carrier } : {}), ...(data.service ? { service: data.service } : {}) },
  settings: { ...(data.settings || {}), ...(includePrintSettings ? {} : {}) },
});
const carrierNames = (response) => {
  const candidates = Array.isArray(response?.data) ? response.data : (Array.isArray(response) ? response : []);
  return [...new Set(candidates.map((carrier) => typeof carrier === 'string' ? carrier : carrier?.name).filter(Boolean))].slice(0, 30);
};
const ratesFrom = (response) => Array.isArray(response?.data) ? response.data : [];
const stringValue = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const generatedShipmentFrom = (response) => {
  const records = [];
  const visit = (value, depth = 0) => {
    if (!value || depth > 5) return;
    if (Array.isArray(value)) { value.forEach((item) => visit(item, depth + 1)); return; }
    if (typeof value !== 'object') return;
    records.push(value);
    Object.values(value).forEach((item) => visit(item, depth + 1));
  };
  visit(response);
  const record = records.find((item) => ['label', 'label_url', 'labelUrl', 'tracking_number', 'trackingNumber', 'track_number', 'trackNumber'].some((key) => item[key] !== undefined)) || {};
  const labelCandidate = record.label || record.label_url || record.labelUrl || record.label_link || record.labelLink;
  const labelUrl = stringValue(labelCandidate) || stringValue(labelCandidate?.url) || stringValue(labelCandidate?.link) || null;
  return {
    trackingNumber: stringValue(record.tracking_number) || stringValue(record.trackingNumber) || stringValue(record.track_number) || stringValue(record.trackNumber) || null,
    labelUrl,
    price: record.totalPrice || record.total_price || record.price || null,
    currency: stringValue(record.currency) || null,
    responseKeys: Object.keys(record).slice(0, 25),
  };
};
exports.quote = async (organizationId, input) => {
  const data = parse(shippingInputSchema, input);
  const settings = await currentSettings(organizationId);
  if (!settings.origin?.name) throw fail(400, 'Configura primero la dirección de origen de Envia');
  if (data.carrier) {
    const response = await request(settings.environment, '/ship/rate/', payloadFor(settings, data, false), { organizationId, carrier: data.carrier, service: data.service, destinationCountry: data.destination.country, destinationPostalCode: data.destination.postalCode, packageCount: data.packages.length });
    const rates = ratesFrom(response);
    console.log(JSON.stringify({ level: 'info', message: 'Envia quote completed', organizationId, environment: settings.environment, carrier: data.carrier, rateCount: rates.length }));
    return { environment: settings.environment, rates, raw: response };
  }

  // Envia documents the rate endpoint as one carrier per request. Discover the
  // enabled carriers first, then request each quote in parallel and merge them.
  const carriersResponse = await request(settings.environment, `/carrier?country_code=${encodeURIComponent(data.destination.country)}`, undefined, { organizationId, api: 'queries', method: 'GET', destinationCountry: data.destination.country });
  const carriers = carrierNames(carriersResponse);
  if (!carriers.length) throw fail(422, `Envia no tiene paqueterías activas para ${data.destination.country}`);
  const results = await Promise.allSettled(carriers.map((carrier) => request(settings.environment, '/ship/rate/', payloadFor(settings, { ...data, carrier }, false), { organizationId, carrier, service: data.service, destinationCountry: data.destination.country, destinationPostalCode: data.destination.postalCode, packageCount: data.packages.length })));
  const rates = results.flatMap((result) => result.status === 'fulfilled' ? ratesFrom(result.value) : []);
  const unavailableCarriers = carriers.filter((carrier, index) => results[index]?.status === 'rejected');
  const emptyRateCarriers = carriers.filter((carrier, index) => results[index]?.status === 'fulfilled' && !ratesFrom(results[index].value).length);
  if (!rates.length) console.warn(JSON.stringify({
    level: 'warn', message: 'Envia all-carrier quote returned no rates', organizationId, environment: settings.environment,
    carrierCount: carriers.length, emptyRateCarriers, unavailableCarriers, destinationCountry: data.destination.country,
    destinationPostalCode: data.destination.postalCode, originCountry: settings.origin.country, originPostalCode: settings.origin.postalCode,
    originState: settings.origin.state, destinationState: data.destination.state,
  }));
  console.log(JSON.stringify({ level: 'info', message: 'Envia all-carrier quote completed', organizationId, environment: settings.environment, carrierCount: carriers.length, rateCount: rates.length, unavailableCarrierCount: unavailableCarriers.length }));
  return { environment: settings.environment, rates, carriers, unavailableCarriers };
};
exports.generate = async (organizationId, input) => {
  const data = parse(shippingInputSchema, input);
  if (!data.carrier || !data.service) throw fail(400, 'Selecciona una paquetería y un servicio antes de generar la guía');
  if (data.conversationId) {
    const conversation = await db.query('SELECT id FROM conversations WHERE id=$1 AND organization_id=$2', [data.conversationId, organizationId]);
    if (!conversation.rows[0]) throw fail(404, 'La conversación seleccionada no pertenece a esta organización');
  }
  const settings = await currentSettings(organizationId);
  if (!settings.origin?.name) throw fail(400, 'Configura primero la dirección de origen de Envia');
  const printSettings = { ...(data.settings || {}), printFormat: data.settings?.printFormat || 'PDF', printSize: data.settings?.printSize || 'STOCK_4X6' };
  const response = await request(settings.environment, '/ship/generate/', payloadFor(settings, { ...data, settings: printSettings }, true), { organizationId, carrier: data.carrier, service: data.service, destinationCountry: data.destination.country, destinationPostalCode: data.destination.postalCode, packageCount: data.packages.length });
  const created = generatedShipmentFrom(response);
  const { trackingNumber, labelUrl } = created;
  const result = await db.query(`INSERT INTO shipments (organization_id, conversation_id, sale_external_id, carrier, service, tracking_number, label_url, shipment_status, status_description, price, currency, origin, destination, packages, envia_response)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'created',NULL,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb)
    RETURNING id, conversation_id AS "conversationId", sale_external_id AS "saleExternalId", carrier, service, tracking_number AS "trackingNumber", label_url AS "labelUrl", shipment_status AS status, price, currency, created_at AS "createdAt"`,
  [organizationId, data.conversationId || null, data.saleExternalId ? String(data.saleExternalId) : null, data.carrier, data.service, trackingNumber, labelUrl, created.price, created.currency || data.settings?.currency || null, JSON.stringify(settings.origin), JSON.stringify(data.destination), JSON.stringify(data.packages), JSON.stringify(response)]);
  console.log(JSON.stringify({ level: 'info', message: 'Envia shipping label stored', organizationId, shipmentId: result.rows[0].id, carrier: data.carrier, service: data.service, trackingNumber: trackingNumber || null, labelAvailable: Boolean(labelUrl), responseKeys: created.responseKeys }));
  return result.rows[0];
};
exports.list = async (organizationId, conversationId) => {
  const result = await db.query(`SELECT shipment.id, shipment.conversation_id AS "conversationId", shipment.sale_external_id AS "saleExternalId", shipment.carrier, shipment.service, shipment.tracking_number AS "trackingNumber", shipment.label_url AS "labelUrl", shipment.shipment_status AS status, shipment.status_description AS "statusDescription", shipment.price, shipment.currency, shipment.destination, shipment.envia_response AS "enviaResponse", shipment.created_at AS "createdAt", shipment.updated_at AS "updatedAt", contact.name AS "customerName", contact.phone_number AS "customerPhone"
    FROM shipments shipment
    LEFT JOIN conversations conversation ON conversation.id=shipment.conversation_id
    LEFT JOIN contacts contact ON contact.id=conversation.contact_id
    WHERE shipment.organization_id=$1 AND ($2::uuid IS NULL OR shipment.conversation_id=$2)
    ORDER BY shipment.created_at DESC`, [organizationId, conversationId || null]);
  return Promise.all(result.rows.map(async (row) => {
    if (!row.labelUrl || !row.trackingNumber) {
      const recovered = generatedShipmentFrom(row.enviaResponse);
      if (recovered.labelUrl || recovered.trackingNumber) {
        const updated = await db.query(`UPDATE shipments SET tracking_number=COALESCE(tracking_number,$2), label_url=COALESCE(label_url,$3), price=COALESCE(price,$4), currency=COALESCE(currency,$5), updated_at=now() WHERE id=$1 RETURNING tracking_number AS "trackingNumber", label_url AS "labelUrl", price, currency, updated_at AS "updatedAt"`, [row.id, recovered.trackingNumber, recovered.labelUrl, recovered.price, recovered.currency]);
        Object.assign(row, updated.rows[0]);
      }
    }
    delete row.enviaResponse;
    return row;
  }));
};
