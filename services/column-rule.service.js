const { z } = require('zod');
const db = require('../lib/db');
const realtime = require('../lib/realtime');
const { normalize } = require('./text-match');

// «Si llega este mensaje → mover a esta columna». La primera regla activa que coincide
// mueve el lead y lo deja fijado; las automatizaciones ya no lo mueven hasta que una
// persona lo mueva a mano.
const phrase = z.string().transform((value) => value.trim().replace(/\s+/g, ' ')).refine((value) => value.length >= 1 && value.length <= 120, 'Cada frase admite de 1 a 120 caracteres');
const schema = z.object({
  name: z.string().transform((value) => value.trim()).refine((value) => value.length >= 1 && value.length <= 80, 'Escribe un nombre de hasta 80 caracteres'),
  phrases: z.array(phrase).min(1, 'Agrega al menos una frase').max(50, 'Máximo 50 frases'),
  matchMode: z.enum(['contains', 'exact']).default('contains'),
  columnId: z.string().uuid('Elige la columna'),
  isActive: z.boolean().default(true),
});
const orderSchema = z.object({ ruleIds: z.array(z.string().uuid()).min(1).max(200) });
const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };
const uuid = (value) => z.string().uuid().safeParse(value).success;
const parse = (input) => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) fail(400, parsed.error.issues[0].message);
  const seen = new Set();
  const phrases = parsed.data.phrases.filter((item) => { const key = normalize(item); if (!key || seen.has(key)) return false; seen.add(key); return true; });
  if (!phrases.length) fail(400, 'Agrega al menos una frase con letras o números');
  return { ...parsed.data, phrases };
};
const COLUMNS = `rule.id, rule.name, rule.phrases, rule.match_mode AS "matchMode", rule.column_id AS "columnId", column_row.name AS "columnName",
  rule.is_active AS "isActive", rule.position, rule.updated_at AS "updatedAt"`;
const requireColumn = async (organizationId, columnId) => {
  const found = await db.query('SELECT 1 FROM lead_columns WHERE id=$1 AND organization_id=$2', [columnId, organizationId]);
  if (!found.rows[0]) fail(400, 'La columna elegida ya no existe');
};
const byId = async (organizationId, id) => (await db.query(
  `SELECT ${COLUMNS} FROM column_rules rule JOIN lead_columns column_row ON column_row.id=rule.column_id WHERE rule.id=$1 AND rule.organization_id=$2`,
  [id, organizationId],
)).rows[0];

exports.list = async (organizationId) => (await db.query(
  `SELECT ${COLUMNS} FROM column_rules rule JOIN lead_columns column_row ON column_row.id=rule.column_id
   WHERE rule.organization_id=$1 ORDER BY rule.position, rule.created_at`,
  [organizationId],
)).rows;

exports.create = async (organizationId, input) => {
  const value = parse(input);
  await requireColumn(organizationId, value.columnId);
  const row = await db.query(
    `INSERT INTO column_rules (organization_id, name, phrases, match_mode, column_id, is_active, position)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE((SELECT MAX(position)+1 FROM column_rules WHERE organization_id=$1),0)) RETURNING id`,
    [organizationId, value.name, value.phrases, value.matchMode, value.columnId, value.isActive],
  );
  return byId(organizationId, row.rows[0].id);
};

exports.update = async (organizationId, id, input) => {
  if (!uuid(id)) fail(404, 'Regla no encontrada');
  const value = parse(input);
  await requireColumn(organizationId, value.columnId);
  const row = await db.query(
    `UPDATE column_rules SET name=$3, phrases=$4, match_mode=$5, column_id=$6, is_active=$7, updated_at=now()
     WHERE id=$1 AND organization_id=$2 RETURNING id`,
    [id, organizationId, value.name, value.phrases, value.matchMode, value.columnId, value.isActive],
  );
  if (!row.rows[0]) fail(404, 'Regla no encontrada');
  return byId(organizationId, id);
};

exports.remove = async (organizationId, id) => {
  if (!uuid(id)) fail(404, 'Regla no encontrada');
  const row = await db.query('DELETE FROM column_rules WHERE id=$1 AND organization_id=$2 RETURNING id', [id, organizationId]);
  if (!row.rows[0]) fail(404, 'Regla no encontrada');
  return { id };
};

/** La primera regla tiene prioridad cuando un mensaje coincide con varias. */
exports.reorder = async (organizationId, input) => {
  const parsed = orderSchema.safeParse(input);
  if (!parsed.success) fail(400, 'Orden inválido');
  await db.query(
    `UPDATE column_rules rule SET position=ordered.ord - 1, updated_at=now()
     FROM unnest($2::uuid[]) WITH ORDINALITY AS ordered(id, ord) WHERE rule.id=ordered.id AND rule.organization_id=$1`,
    [organizationId, parsed.data.ruleIds],
  );
  return exports.list(organizationId);
};

/** Texto del cliente: mensaje, opción elegida o descripción de una foto/video/documento. */
const messageText = (message) => message?.text?.body
  || message?.interactive?.button_reply?.title || message?.interactive?.list_reply?.title
  || message?.button?.text || message?.image?.caption || message?.video?.caption || message?.document?.caption || '';

/** Regla que coincide con el texto: «contiene» busca la frase como palabras completas; «exacto», el mensaje completo. */
const matchRule = (rules, text) => {
  const value = normalize(text);
  if (!value) return null;
  return rules.find((rule) => rule.isActive !== false && (rule.phrases || []).some((item) => {
    const target = normalize(item);
    if (!target) return false;
    return rule.matchMode === 'exact' ? value === target : ` ${value} `.includes(` ${target} `);
  })) || null;
};
exports.matchRule = matchRule;
exports.messageText = messageText;

/** Aplica las reglas a un mensaje entrante. Devuelve la regla usada o null. */
exports.applyIncoming = async (organizationId, conversationId, message) => {
  const text = messageText(message);
  if (!text) return null;
  const rules = (await exports.list(organizationId)).filter((rule) => rule.isActive);
  const rule = matchRule(rules, text);
  if (!rule) return null;
  await db.query(
    `UPDATE conversations SET lead_column_id=$3, column_pinned_at=now(), column_pinned_rule_id=$4, updated_at=now()
     WHERE id=$1 AND organization_id=$2`,
    [conversationId, organizationId, rule.columnId, rule.id],
  );
  await realtime.publish(organizationId, 'lead.moved', conversationId);
  console.log(JSON.stringify({ level: 'info', message: 'Lead moved by column rule', conversationId, ruleId: rule.id }));
  return rule;
};
