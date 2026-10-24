const { z } = require('zod');
const db = require('../lib/db');
const queue = require('../lib/queue');
const templates = require('./whatsapp-template.service');

// Recordatorios para escribirle a un cliente. Cada uno crea una venta pendiente de pago.
// Cuando llega la hora:
//   - manual: aviso en el chat interno «Recordatorios» con enlaces a WhatsApp.
//   - plantilla: se envía la plantilla oficial y el chat interno avisa si salió o falló.
const STATUSES = ['scheduled', 'done', 'cancelled'];
const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };
const text = (max, label) => z.string().trim().max(max, `${label} admite máximo ${max} caracteres`);
const line = z.object({
  kind: z.enum(['product', 'bundle', 'custom']),
  id: z.number().int().positive().optional(),
  name: z.string().trim().min(1, 'Cada producto necesita nombre').max(160),
  quantity: z.number().int().min(1, 'La cantidad mínima es 1').max(100000),
}).refine((item) => item.kind === 'custom' || item.id, 'Selecciona un producto del inventario');

/** Solo dígitos con lada de país; 10 dígitos se toman como celular de México (52). */
const normalizePhone = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 10 ? `52${digits}` : digits;
};
const schema = z.object({
  contactName: text(120, 'El nombre').min(1, 'Escribe el nombre de la persona'),
  phone: z.string().trim().max(25).transform(normalizePhone).refine((value) => /^\d{8,15}$/.test(value), 'Escribe un celular válido (10 dígitos o con lada de país)'),
  products: z.array(line).max(30, 'Máximo 30 productos').default([]),
  notes: text(2000, 'Las notas').optional().nullable(),
  remindAt: z.string().trim().refine((value) => !Number.isNaN(Date.parse(value)), 'Indica la fecha y hora del recordatorio'),
  agreedDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha acordada no es válida').optional().nullable().or(z.literal('')),
  sendMode: z.enum(['manual', 'template']).default('manual'),
  templateId: z.string().uuid('Elige la plantilla').optional().nullable(),
  templateMappings: templates.reminderMappingSchema.default([]),
});
const parse = (input) => {
  const result = schema.safeParse(input || {});
  if (!result.success) fail(400, result.error.issues[0].message);
  return { ...result.data, agreedDate: result.data.agreedDate || null };
};
const columns = `r.id, r.contact_name AS "contactName", r.phone, r.products, r.notes, r.remind_at AS "remindAt", r.status,
  r.notified_at AS "notifiedAt", r.agreed_date::text AS "agreedDate", r.send_mode AS "sendMode", r.template_id AS "templateId",
  r.template_mappings AS "templateMappings", r.conversation_id AS "conversationId", r.send_error AS "sendError",
  r.sent_message_id AS "sentMessageId", m.status AS "sentMessageStatus", t.name AS "templateName",
  r.sale_id AS "saleId", s.status AS "saleStatus", s.amount::text AS "saleAmount", s.control_sale_id AS "saleControlId",
  r.created_at AS "createdAt", r.updated_at AS "updatedAt"`;
const from = `reminders r
  LEFT JOIN pending_sales s ON s.id = r.sale_id
  LEFT JOIN whatsapp_templates t ON t.id = r.template_id
  LEFT JOIN messages m ON m.id = r.sent_message_id`;
const uuid = (value) => z.string().uuid().safeParse(value).success;
const notFound = () => fail(404, 'Recordatorio no encontrado');
const byId = async (organizationId, id, client = db) => (await client.query(`SELECT ${columns} FROM ${from} WHERE r.id=$1 AND r.organization_id=$2`, [id, organizationId])).rows[0];

/** «sábado, 25 de octubre». */
const dateLabel = (isoDate) => (isoDate ? new Date(`${isoDate}T12:00:00Z`).toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }) : '');
const productsText = (products) => (Array.isArray(products) ? products : []).map((item) => `${item.quantity} × ${item.name}`).join(', ');
/** Valores que llenan la plantilla. */
const templateValues = (reminder) => ({
  'reminder.name': reminder.contactName,
  'reminder.products': productsText(reminder.products),
  'reminder.agreed_date': dateLabel(reminder.agreedDate),
});
exports.templateValues = templateValues;
exports.dateLabel = dateLabel;

/** Revisa al guardar que la plantilla esté aprobada y que cada variable tenga valor. */
const checkTemplate = async (organizationId, value) => {
  if (value.sendMode !== 'template') return;
  if (!value.templateId) fail(400, 'Elige la plantilla de WhatsApp para el envío automático');
  await templates.resolveForReminder(organizationId, value.templateId, value.templateMappings, templateValues(value));
};

/** Conversación existente con ese número (con o sin el 1 de los celulares de México). */
const findConversation = async (client, organizationId, phone) => {
  const variants = [phone];
  if (/^52\d{10}$/.test(phone)) variants.push(`521${phone.slice(2)}`);
  if (/^521\d{10}$/.test(phone)) variants.push(`52${phone.slice(3)}`);
  const found = await client.query(
    `SELECT cv.id FROM contacts c JOIN conversations cv ON cv.contact_id = c.id
     WHERE c.organization_id=$1 AND c.phone_number = ANY($2::text[]) ORDER BY cv.updated_at DESC LIMIT 1`,
    [organizationId, variants],
  );
  return found.rows[0]?.id || null;
};

exports.normalizePhone = normalizePhone;

exports.list = async (organizationId, query = {}) => {
  const view = query.view || 'upcoming';
  if (!['upcoming', 'done', 'all'].includes(view)) fail(400, 'Filtro inválido');
  const where = view === 'all' ? '' : view === 'done' ? "AND r.status IN ('done','cancelled')" : "AND r.status='scheduled'";
  const order = view === 'upcoming' ? 'r.remind_at ASC' : 'r.remind_at DESC';
  return (await db.query(`SELECT ${columns} FROM ${from} WHERE r.organization_id=$1 ${where} ORDER BY ${order}, r.created_at ASC LIMIT 500`, [organizationId])).rows;
};

exports.create = async (organizationId, userId, input) => {
  const value = parse(input);
  await checkTemplate(organizationId, value);
  return db.transaction(async (client) => {
    const conversationId = await findConversation(client, organizationId, value.phone);
    const sale = await client.query(
      `INSERT INTO pending_sales (organization_id, conversation_id, contact_name, phone, items) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id`,
      [organizationId, conversationId, value.contactName, value.phone, JSON.stringify(value.products)],
    );
    const inserted = await client.query(
      `INSERT INTO reminders (organization_id, contact_name, phone, products, notes, remind_at, created_by, sale_id, send_mode, template_id, template_mappings, agreed_date, conversation_id)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13) RETURNING id`,
      [organizationId, value.contactName, value.phone, JSON.stringify(value.products), value.notes || null, new Date(value.remindAt), userId || null,
        sale.rows[0].id, value.sendMode, value.sendMode === 'template' ? value.templateId : null, JSON.stringify(value.sendMode === 'template' ? value.templateMappings : []), value.agreedDate, conversationId],
    );
    return byId(organizationId, inserted.rows[0].id, client);
  });
};

exports.update = async (organizationId, id, input) => {
  if (!uuid(id)) notFound();
  const value = parse(input);
  await checkTemplate(organizationId, value);
  return db.transaction(async (client) => {
    // Si cambia la hora, se vuelve a avisar (y a enviar) en la nueva hora.
    const updated = await client.query(
      `UPDATE reminders SET contact_name=$3, phone=$4, products=$5::jsonb, notes=$6,
         notified_at = CASE WHEN remind_at = $7 THEN notified_at ELSE NULL END,
         sent_message_id = CASE WHEN remind_at = $7 THEN sent_message_id ELSE NULL END,
         send_error = CASE WHEN remind_at = $7 THEN send_error ELSE NULL END,
         remind_at=$7, send_mode=$8, template_id=$9, template_mappings=$10::jsonb, agreed_date=$11, updated_at=now()
       WHERE id=$1 AND organization_id=$2 RETURNING sale_id`,
      [id, organizationId, value.contactName, value.phone, JSON.stringify(value.products), value.notes || null, new Date(value.remindAt),
        value.sendMode, value.sendMode === 'template' ? value.templateId : null, JSON.stringify(value.sendMode === 'template' ? value.templateMappings : []), value.agreedDate],
    );
    if (!updated.rows[0]) notFound();
    if (updated.rows[0].sale_id) await client.query(
      "UPDATE pending_sales SET contact_name=$3, phone=$4, items=$5::jsonb, updated_at=now() WHERE id=$1 AND organization_id=$2 AND status='open'",
      [updated.rows[0].sale_id, organizationId, value.contactName, value.phone, JSON.stringify(value.products)],
    );
    return byId(organizationId, id, client);
  });
};

/** Solo actualiza los productos (p. ej. para agregar color y talla) sin tocar hora ni estado. */
exports.setProducts = async (organizationId, id, input) => {
  if (!uuid(id)) notFound();
  const parsed = z.array(line).max(30, 'Máximo 30 productos').safeParse(input?.products);
  if (!parsed.success) fail(400, parsed.error.issues[0]?.message || 'Productos inválidos');
  return db.transaction(async (client) => {
    const updated = await client.query(
      "UPDATE reminders SET products=$3::jsonb, updated_at=now() WHERE id=$1 AND organization_id=$2 AND status='scheduled' AND notified_at IS NULL RETURNING sale_id",
      [id, organizationId, JSON.stringify(parsed.data)],
    );
    if (!updated.rows[0]) fail(409, 'Este recordatorio ya se avisó o se cerró.');
    if (updated.rows[0].sale_id) await client.query(
      "UPDATE pending_sales SET items=$3::jsonb, updated_at=now() WHERE id=$1 AND organization_id=$2 AND status='open'",
      [updated.rows[0].sale_id, organizationId, JSON.stringify(parsed.data)],
    );
    return byId(organizationId, id, client);
  });
};

exports.setStatus = async (organizationId, id, input) => {
  if (!uuid(id)) notFound();
  const status = input?.status;
  if (!STATUSES.includes(status)) fail(400, 'Estado inválido');
  const current = await byId(organizationId, id);
  if (!current) notFound();
  if (status === 'scheduled' && current.saleStatus && current.saleStatus !== 'open') fail(409, 'La venta de este recordatorio ya está cerrada; no se puede reabrir.');
  await db.query('UPDATE reminders SET status=$3, updated_at=now() WHERE id=$1 AND organization_id=$2', [id, organizationId, status]);
  return byId(organizationId, id);
};

exports.remove = async (organizationId, id) => {
  if (!uuid(id)) notFound();
  return db.transaction(async (client) => {
    const deleted = await client.query('DELETE FROM reminders WHERE id=$1 AND organization_id=$2 RETURNING sale_id', [id, organizationId]);
    if (!deleted.rows[0]) notFound();
    // La venta pendiente nació con el recordatorio; si no se pagó, se elimina con él.
    if (deleted.rows[0].sale_id) await client.query("DELETE FROM pending_sales WHERE id=$1 AND organization_id=$2 AND status='open'", [deleted.rows[0].sale_id, organizationId]);
    return { id };
  });
};

/** «+52 272 123 4567» para leerlo fácil en el chat. */
const phoneLabel = (phone) => {
  const digits = String(phone || '');
  if (digits.length < 11) return digits;
  const local = digits.slice(-10);
  return `+${digits.slice(0, -10)} ${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;
};
const productLines = (products) => (Array.isArray(products) ? products : []).map((item) => `• ${item.quantity} × ${item.name}`);
const details = (reminder) => [
  ...(reminder.products?.length ? ['', 'Quiere comprar:', ...productLines(reminder.products)] : []),
  ...(reminder.agreedDate ? ['', `Fecha acordada: ${dateLabel(reminder.agreedDate)}`] : []),
  ...(reminder.notes ? ['', `Notas: ${reminder.notes}`] : []),
];
/** Texto del aviso manual en el chat interno. */
exports.reminderBody = (reminder) => [`⏰ Es hora de escribirle a ${reminder.contactName} (${phoneLabel(reminder.phone)}).`, ...details(reminder)].join('\n');
const sentBody = (reminder) => [`✅ Se envió el recordatorio automático a ${reminder.contactName} (${phoneLabel(reminder.phone)}) con la plantilla «${reminder.templateName || 'WhatsApp'}».`, ...details(reminder)].join('\n');
const failedBody = (reminder, error) => [`⚠️ No se pudo enviar el recordatorio automático a ${reminder.contactName} (${phoneLabel(reminder.phone)}): ${error}`, 'Escríbele manualmente con los botones.', ...details(reminder)].join('\n');
const payloadOf = (reminder, extra) => JSON.stringify({
  contactName: reminder.contactName, phone: reminder.phone, products: reminder.products || [], notes: reminder.notes || null,
  remindAt: reminder.remindAt, agreedDate: reminder.agreedDate || null, conversationId: reminder.conversationId || null, ...extra,
});
const post = (organizationId, reminderId, body, payload) => db.query(
  "INSERT INTO internal_messages (organization_id, kind, body, reminder_id, payload) VALUES ($1,'reminder',$2,$3,$4::jsonb)",
  [organizationId, body.slice(0, 4000), reminderId, payload],
);

const dueColumns = `r.id, r.organization_id AS "organizationId", r.contact_name AS "contactName", r.phone, r.products, r.notes, r.remind_at AS "remindAt",
  r.agreed_date::text AS "agreedDate", r.send_mode AS "sendMode", r.template_id AS "templateId", r.template_mappings AS "templateMappings",
  r.conversation_id AS "conversationId", r.sale_id AS "saleId"`;

/** Envía la plantilla: crea (o usa) la conversación y deja el mensaje en la cola de salida. */
const sendWithTemplate = async (reminder) => {
  const resolved = await templates.resolveForReminder(reminder.organizationId, reminder.templateId, reminder.templateMappings, templateValues(reminder));
  let conversationId = reminder.conversationId;
  if (!conversationId) {
    const conversations = require('./conversation.service');
    conversationId = (await conversations.create(reminder.organizationId, { phoneNumber: reminder.phone, name: reminder.contactName })).id;
  }
  const payload = { templateName: resolved.template.name, language: resolved.template.language, components: resolved.components, templateId: resolved.template.id };
  const message = await db.query(
    "INSERT INTO messages (organization_id, conversation_id, direction, type, body, status) VALUES ($1,$2,'outbound','template',$3,'pending') RETURNING id",
    [reminder.organizationId, conversationId, JSON.stringify(payload)],
  );
  const messageId = message.rows[0].id;
  await db.query('UPDATE reminders SET conversation_id=$2, sent_message_id=$3, send_error=NULL, updated_at=now() WHERE id=$1', [reminder.id, conversationId, messageId]);
  if (reminder.saleId) await db.query('UPDATE pending_sales SET conversation_id=COALESCE(conversation_id, $2), updated_at=now() WHERE id=$1', [reminder.saleId, conversationId]);
  await queue.outboundQueue().add('send-template', { messageId }, { jobId: messageId });
  // El aviso en el chat interno llega cuando el worker confirma el envío (onTemplateResult).
};

const sendFailed = async (reminder, error) => {
  const message = String(error?.message || error || 'Error desconocido').slice(0, 900);
  await db.query('UPDATE reminders SET send_error=$2, updated_at=now() WHERE id=$1', [reminder.id, message]);
  const named = reminder.templateName ? reminder : { ...reminder, templateName: (await db.query('SELECT name FROM whatsapp_templates WHERE id=$1', [reminder.templateId]).catch(() => ({ rows: [] }))).rows[0]?.name };
  await post(reminder.organizationId, reminder.id, failedBody(named, message), payloadOf(reminder, { mode: 'template', delivery: 'failed', error: message }));
};

/**
 * Atiende los recordatorios que ya llegaron a su hora. Cada uno se reclama una sola vez,
 * aunque varios procesos revisen a la vez. Se omiten los de ventas ya cerradas.
 * Devuelve las organizaciones con avisos nuevos en el chat interno.
 */
exports.deliverDue = async (organizationId = null, limit = 100) => {
  const claimed = (await db.query(
    `UPDATE reminders r SET notified_at=now(), updated_at=now()
     WHERE r.id IN (
       SELECT x.id FROM reminders x
       WHERE x.status='scheduled' AND x.notified_at IS NULL AND x.remind_at <= now() ${organizationId ? 'AND x.organization_id=$2' : ''}
         AND NOT EXISTS (SELECT 1 FROM pending_sales s WHERE s.id = x.sale_id AND s.status <> 'open')
       ORDER BY x.remind_at LIMIT $1 FOR UPDATE SKIP LOCKED
     )
     RETURNING ${dueColumns}`,
    organizationId ? [limit, organizationId] : [limit],
  )).rows;
  const notified = new Set();
  for (const reminder of claimed) {
    try {
      if (reminder.sendMode === 'template') await sendWithTemplate(reminder);
      else {
        await post(reminder.organizationId, reminder.id, exports.reminderBody(reminder), payloadOf(reminder, { mode: 'manual' }));
        notified.add(reminder.organizationId);
      }
    } catch (error) {
      await sendFailed(reminder, error).catch(() => undefined);
      notified.add(reminder.organizationId);
    }
  }
  return [...notified];
};

/**
 * El worker confirma el resultado del envío de una plantilla. Si el mensaje era de un
 * recordatorio, avisa en el chat interno. Devuelve la organización avisada o null.
 */
exports.onTemplateResult = async (messageId, status, error) => {
  const found = (await db.query(
    `SELECT r.id, r.organization_id AS "organizationId", r.contact_name AS "contactName", r.phone, r.products, r.notes, r.remind_at AS "remindAt",
       r.agreed_date::text AS "agreedDate", r.conversation_id AS "conversationId", r.template_id AS "templateId", t.name AS "templateName"
     FROM reminders r LEFT JOIN whatsapp_templates t ON t.id = r.template_id WHERE r.sent_message_id=$1`,
    [messageId],
  )).rows[0];
  if (!found) return null;
  if (status === 'sent') await post(found.organizationId, found.id, sentBody(found), payloadOf(found, { mode: 'template', delivery: 'sent' }));
  else await sendFailed(found, error || 'WhatsApp rechazó el mensaje');
  return found.organizationId;
};
