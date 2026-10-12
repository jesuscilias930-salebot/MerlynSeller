const { z } = require('zod');
const db = require('../lib/db');
const { redactor } = require('./conversation-analysis-redaction');

const fail = (status, message) => Object.assign(new Error(message), { status });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T12:00:00Z`);
  return value >= '1900-01-01' && value <= '9999-12-31' && !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Selecciona una fecha válida.');
const uniqueIds = (max) => z.array(z.string().uuid()).min(1).max(max).refine(ids => new Set(ids).size === ids.length, 'La selección contiene elementos repetidos.');
const filterFields = {
  columnIds: uniqueIds(30), startDate: day, endDate: day,
  inactiveDays: z.union([z.literal(0), z.literal(3), z.literal(7), z.literal(14), z.literal(30)]).default(0),
  limit: z.number().int().min(1).max(50).default(50),
};
const validRange = value => {
  const days = (Date.parse(`${value.endDate}T12:00:00Z`) - Date.parse(`${value.startDate}T12:00:00Z`)) / 86400000;
  return Number.isFinite(days) && days >= 0 && days <= 365;
};
const filters = z.object(filterFields).strict().refine(validRange, 'Usa un periodo ordenado de hasta 366 días.');
const selection = z.object({ ...filterFields, conversationIds: uniqueIds(50) }).strict().refine(validRange, 'Usa un periodo ordenado de hasta 366 días.')
  .refine(value => value.conversationIds.length <= value.limit, 'La selección supera el límite del lote.');
function parse(schema, input) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw fail(400, parsed.error.issues[0].message);
  return parsed.data;
}
let preparing = 0;
const messageTypes = new Set(['text', 'image', 'video', 'audio', 'document', 'sticker', 'contacts', 'location', 'order', 'button', 'interactive', 'system']);

async function readOnly(callback) {
  return db.transaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '15s'");
    return callback(client);
  });
}
async function ensureColumns(client, organizationId, columnIds) {
  const result = await client.query('SELECT id FROM lead_columns WHERE organization_id=$1 AND id=ANY($2::uuid[])', [organizationId, columnIds]);
  if (result.rows.length !== columnIds.length) throw fail(400, 'Una de las columnas seleccionadas no está disponible. Actualiza la página.');
}
async function candidates(client, organizationId, userId, value, ids = null) {
  return (await client.query(`SELECT c.id, ct.name, ct.phone_number,
      lc.id AS "columnId", lc.name AS "columnName", activity.last_message_at AS "lastMessageAt",
      activity.message_count AS "messageCount"
    FROM conversations c
    JOIN contacts ct ON ct.id=c.contact_id AND ct.organization_id=$1
    JOIN lead_columns lc ON lc.id=c.lead_column_id AND lc.organization_id=$1
    JOIN LATERAL (
      SELECT max(m.created_at) AS last_message_at, count(*)::int AS message_count FROM messages m
      WHERE m.organization_id=$1 AND m.conversation_id=c.id AND m.deleted_at IS NULL AND m.status<>'deleted'
        AND NOT EXISTS (SELECT 1 FROM message_user_deletions hidden WHERE hidden.message_id=m.id AND hidden.user_id=$2)
    ) activity ON activity.message_count>0
    WHERE c.organization_id=$1 AND c.lead_column_id=ANY($3::uuid[])
      AND ($7::uuid[] IS NULL OR c.id=ANY($7::uuid[]))
      AND activity.last_message_at>=($4::date::timestamp AT TIME ZONE 'America/Mexico_City')
      AND activity.last_message_at<((($5::date+1)::timestamp) AT TIME ZONE 'America/Mexico_City')
      AND ($6::int=0 OR activity.last_message_at<=now()-($6::int*INTERVAL '1 day'))
    ORDER BY activity.last_message_at DESC, c.id LIMIT $8`,
  [organizationId, userId, value.columnIds, value.startDate, value.endDate, value.inactiveDays, ids, ids ? ids.length : value.limit + 1])).rows;
}

exports.columns = async organizationId => (await db.query(`SELECT lc.id, lc.name, count(c.id)::int AS "conversationCount"
  FROM lead_columns lc LEFT JOIN conversations c ON c.lead_column_id=lc.id AND c.organization_id=$1
  WHERE lc.organization_id=$1 GROUP BY lc.id ORDER BY lc.position, lc.created_at`, [organizationId])).rows;

exports.preview = async (organizationId, userId, input) => {
  const value = parse(filters, input);
  return readOnly(async client => {
    await ensureColumns(client, organizationId, value.columnIds);
    const rows = await candidates(client, organizationId, userId, value);
    return { conversations: rows.slice(0, value.limit).map(({ phone_number, ...row }) => ({ ...row, name: row.name || 'Contacto sin nombre' })),
      hasMore: rows.length > value.limit, limit: value.limit, timezone: 'America/Mexico_City' };
  });
};

exports.prepare = async (organizationId, userId, input) => {
  const value = parse(selection, input);
  if (preparing >= 2) throw fail(429, 'Ya se están preparando otros archivos. Espera un momento y vuelve a intentar.');
  preparing++;
  try {
    return await readOnly(async client => {
      await ensureColumns(client, organizationId, value.columnIds);
      const rows = await candidates(client, organizationId, userId, value, value.conversationIds);
      if (rows.length !== value.conversationIds.length) throw fail(409, 'La selección cambió o alguna conversación ya no cumple los filtros. Vuelve a buscar antes de preparar el archivo.');
      const messages = await client.query(`SELECT chosen.id AS "conversationId", history.id, history.direction, history.type,
        left(history.body, 6000) AS body, char_length(history.body)>6000 AS "bodyTruncated", history.status, history.created_at AS "createdAt"
        FROM conversations chosen JOIN LATERAL (
          SELECT m.id, m.direction, m.type, m.body, m.status, m.created_at FROM messages m
          WHERE m.organization_id=$1 AND m.conversation_id=chosen.id AND m.deleted_at IS NULL AND m.status<>'deleted'
            AND NOT EXISTS (SELECT 1 FROM message_user_deletions hidden WHERE hidden.message_id=m.id AND hidden.user_id=$2)
          ORDER BY m.created_at DESC, m.id DESC LIMIT 100
        ) history ON true
        WHERE chosen.organization_id=$1 AND chosen.id=ANY($3::uuid[])
        ORDER BY chosen.id, history.created_at ASC, history.id ASC`, [organizationId, userId, value.conversationIds]);
      const hide = redactor(rows);
      const grouped = new Map(rows.map(row => [row.id, []]));
      for (const message of messages.rows) grouped.get(message.conversationId)?.push(message);
      let redactionCount = 0;
      const conversations = rows.map((row, index) => {
        let chars = 0, shortened = false;
        const exported = [];
        // Keep the newest bounded history, then restore chronological order.
        for (const message of [...grouped.get(row.id)].reverse()) {
          const hidden = hide(message.body);
          const type = messageTypes.has(message.type) ? message.type : 'other';
          const content = (hidden.text || (type === 'text' ? '[Mensaje sin texto disponible]' : `[Adjunto o mensaje ${type}: contenido no analizado]`)) + (message.bodyTruncated ? '\n[Texto recortado por límite de tamaño]' : '');
          if (chars + content.length > 24000) { shortened = true; break; }
          chars += content.length;
          redactionCount += hidden.changes;
          if (message.bodyTruncated) shortened = true;
          exported.push({ reference: '', speaker: message.direction === 'inbound' ? 'Cliente' : 'Negocio',
            type, deliveryStatus: String(message.status).slice(0, 30),
            at: new Date(message.createdAt).toISOString(), text: content });
        }
        exported.reverse().forEach((message, messageIndex) => { message.reference = `M${String(messageIndex + 1).padStart(3, '0')}`; });
        const omittedMessages = Math.max(0, row.messageCount - exported.length);
        const column = hide(row.columnName); redactionCount += column.changes;
        return { alias: `C${String(index + 1).padStart(3, '0')}`, column: column.text,
          lastMessageAt: new Date(row.lastMessageAt).toISOString(), totalVisibleMessages: row.messageCount,
          omittedMessages, partial: shortened || omittedMessages > 0, saleOutcome: 'No verificado: la columna no acredita una compra ni su ausencia.', messages: exported };
      });
      return { generatedAt: new Date().toISOString(), timezone: 'America/Mexico_City',
        filters: { startDate: value.startDate, endDate: value.endDate, inactiveDays: value.inactiveDays },
        conversationIndex: rows.map((row, index) => ({ alias: conversations[index].alias, id: row.id })),
        redactionCount, conversations };
    });
  } finally { preparing--; }
};
