const { z } = require('zod');
const db = require('../lib/db');

const graphConfig = () => {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const businessAccountId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  const version = process.env.WHATSAPP_GRAPH_API_VERSION;
  if (!accessToken || !businessAccountId || !/^v\d+\.\d+$/.test(version || '')) {
    const error = new Error('Falta configurar WHATSAPP_BUSINESS_ACCOUNT_ID para sincronizar plantillas.');
    error.status = 503;
    throw error;
  }
  return { accessToken, businessAccountId, version };
};

const extractVariables = (components) => components.flatMap(component => {
  const text = String(component.text || '');
  return [...text.matchAll(/{{(\d+)}}/g)].map(match => ({ component: String(component.type || 'BODY').toLowerCase(), position: Number(match[1]) }));
});

const response = (row) => ({
  id: row.id, metaTemplateId: row.meta_template_id, name: row.name, language: row.language,
  status: row.status, category: row.category, components: row.components || [],
  variables: extractVariables(row.components || []), mappings: row.variable_mappings || [],
  updatedAt: row.updated_at,
});

exports.list = async (organizationId) => (await db.query(`
  SELECT * FROM whatsapp_templates WHERE organization_id=$1 ORDER BY status='APPROVED' DESC, name, language
`, [organizationId])).rows.map(response);

exports.sync = async (organizationId) => {
  const { accessToken, businessAccountId, version } = graphConfig();
  const url = new URL(`https://graph.facebook.com/${version}/${businessAccountId}/message_templates`);
  url.searchParams.set('fields', 'id,name,language,status,category,components,last_updated_time');
  url.searchParams.set('limit', '250');
  const metaResponse = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(Number(process.env.WHATSAPP_REQUEST_TIMEOUT_MS || 10000)) });
  const payload = await metaResponse.json().catch(() => ({}));
  if (!metaResponse.ok) {
    const error = new Error(payload?.error?.error_data?.details || payload?.error?.message || 'Meta rechazó la sincronización de plantillas.');
    error.status = metaResponse.status >= 500 ? 502 : 400;
    throw error;
  }
  const templates = Array.isArray(payload.data) ? payload.data : [];
  await db.transaction(async client => {
    for (const template of templates) {
      const rawUpdatedAt = template.last_updated_time;
      const parsedUpdatedAt = rawUpdatedAt
        ? new Date(typeof rawUpdatedAt === 'number' ? rawUpdatedAt * 1000 : rawUpdatedAt)
        : null;
      await client.query(`
        INSERT INTO whatsapp_templates (organization_id,meta_template_id,name,language,status,category,components,meta_updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (organization_id,meta_template_id,language) DO UPDATE SET
          name=EXCLUDED.name, status=EXCLUDED.status, category=EXCLUDED.category,
          components=EXCLUDED.components, meta_updated_at=EXCLUDED.meta_updated_at, updated_at=now()
      `, [organizationId, template.id, template.name, template.language, template.status, template.category || null, JSON.stringify(template.components || []), parsedUpdatedAt && !Number.isNaN(parsedUpdatedAt.getTime()) ? parsedUpdatedAt : null]);
    }
  });
  return exports.list(organizationId);
};

const mappingSchema = z.array(z.object({
  component: z.enum(['body', 'header']),
  position: z.coerce.number().int().positive(),
  source: z.enum(['contact.name', 'contact.phone', 'fixed', 'manual']),
  value: z.string().trim().max(1024).optional(),
  label: z.string().trim().max(120).optional(),
})).max(30);

exports.updateMappings = async (organizationId, id, mappings) => {
  const parsed = mappingSchema.safeParse(mappings);
  if (!parsed.success) { const error = new Error(parsed.error.issues[0].message); error.status = 400; throw error; }
  const result = await db.query(`UPDATE whatsapp_templates SET variable_mappings=$3,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *`, [id, organizationId, JSON.stringify(parsed.data)]);
  if (!result.rows[0]) { const error = new Error('Plantilla no encontrada.'); error.status = 404; throw error; }
  return response(result.rows[0]);
};

exports.resolveForConversation = async (organizationId, conversationId, templateId, manualValues = {}) => {
  const template = await db.query('SELECT * FROM whatsapp_templates WHERE id=$1 AND organization_id=$2 AND status=$3', [templateId, organizationId, 'APPROVED']);
  if (!template.rows[0]) { const error = new Error('La plantilla aprobada no fue encontrada.'); error.status = 404; throw error; }
  const contact = await db.query(`SELECT ct.name,ct.phone_number FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE c.id=$1 AND c.organization_id=$2`, [conversationId, organizationId]);
  if (!contact.rows[0]) { const error = new Error('Conversación no encontrada.'); error.status = 404; throw error; }
  return { template: response(template.rows[0]), phoneNumber: contact.rows[0].phone_number, components: exports.buildComponents(template.rows[0], contact.rows[0], manualValues) };
};

/** Parámetros de la plantilla para un contacto: nombre, teléfono, texto fijo o valores escritos al enviar. */
exports.buildComponents = (templateRow, contact, manualValues = {}) => {
  const mappings = templateRow.variable_mappings || [];
  const variables = extractVariables(templateRow.components || []);
  const mappingByKey = new Map(mappings.map(mapping => [`${mapping.component}:${mapping.position}`, mapping]));
  const byComponent = new Map();
  for (const variable of variables) {
    const mapping = mappingByKey.get(`${variable.component}:${variable.position}`);
    if (!mapping) { const error = new Error(`Configura la variable {{${variable.position}}} del ${variable.component}.`); error.status = 400; throw error; }
    const key = `${variable.component}:${variable.position}`;
    const value = mapping.source === 'contact.name' ? contact.name
      : mapping.source === 'contact.phone' ? contact.phone_number
        : mapping.source === 'fixed' ? mapping.value
          : manualValues[key];
    if (!String(value || '').trim()) { const error = new Error(`Falta el valor para ${mapping.label || `{{${variable.position}}}`}.`); error.status = 400; throw error; }
    const current = byComponent.get(variable.component) || [];
    current.push({ position: variable.position, value: String(value).trim() });
    byComponent.set(variable.component, current);
  }
  return [...byComponent.entries()].map(([type, values]) => ({ type, parameters: values.sort((a, b) => a.position - b.position).map(item => ({ type: 'text', text: item.value })) }));
};
exports.templateResponse = (row) => response(row);

// Variables de plantilla que salen de un recordatorio (nombre, productos, fecha acordada).
const REMINDER_SOURCES = ['reminder.name', 'reminder.products', 'reminder.agreed_date', 'fixed'];
exports.REMINDER_SOURCES = REMINDER_SOURCES;
exports.reminderMappingSchema = z.array(z.object({
  component: z.enum(['body', 'header']),
  position: z.coerce.number().int().positive(),
  source: z.enum(REMINDER_SOURCES),
  value: z.string().trim().max(1024).optional(),
})).max(30);

/** WhatsApp no admite saltos de línea ni más de 4 espacios seguidos en un parámetro. */
const parameterText = (value) => String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim().slice(0, 1024);

/**
 * Componentes para enviar una plantilla aprobada con los datos de un recordatorio.
 * `values` trae { 'reminder.name', 'reminder.products', 'reminder.agreed_date' }.
 */
exports.resolveForReminder = async (organizationId, templateId, mappings, values) => {
  const template = await db.query('SELECT * FROM whatsapp_templates WHERE id=$1 AND organization_id=$2', [templateId, organizationId]);
  const row = template.rows[0];
  if (!row) { const error = new Error('La plantilla del recordatorio ya no existe. Sincroniza tus plantillas y elige otra.'); error.status = 400; throw error; }
  if (row.status !== 'APPROVED') { const error = new Error(`La plantilla «${row.name}» no está aprobada por WhatsApp (${row.status}).`); error.status = 400; throw error; }
  const byKey = new Map((mappings || []).map(mapping => [`${mapping.component}:${mapping.position}`, mapping]));
  const byComponent = new Map();
  for (const variable of extractVariables(row.components || [])) {
    const mapping = byKey.get(`${variable.component}:${variable.position}`);
    if (!mapping) { const error = new Error(`Elige qué va en la variable {{${variable.position}}} de la plantilla «${row.name}».`); error.status = 400; throw error; }
    const value = parameterText(mapping.source === 'fixed' ? mapping.value : values[mapping.source]);
    if (!value) { const error = new Error(`Falta el valor de {{${variable.position}}} (${mapping.source === 'reminder.products' ? 'productos' : mapping.source === 'reminder.agreed_date' ? 'fecha acordada' : mapping.source === 'reminder.name' ? 'nombre' : 'texto fijo'}).`); error.status = 400; throw error; }
    const current = byComponent.get(variable.component) || [];
    current.push({ position: variable.position, value });
    byComponent.set(variable.component, current);
  }
  const components = [...byComponent.entries()].map(([type, list]) => ({ type, parameters: list.sort((a, b) => a.position - b.position).map(item => ({ type: 'text', text: item.value })) }));
  return { template: response(row), components };
};
exports.extractVariables = extractVariables;
