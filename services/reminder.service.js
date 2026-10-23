const { z } = require('zod');
const db = require('../lib/db');

// Recordatorios para escribirle a un cliente. Cuando llega la hora, se publica un
// mensaje en el chat interno «Recordatorios» del inbox (no se envía por WhatsApp).
const STATUSES = ['scheduled', 'done'];
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
});
const parse = (input) => {
  const result = schema.safeParse(input || {});
  if (!result.success) fail(400, result.error.issues[0].message);
  return result.data;
};
const columns = `id, contact_name AS "contactName", phone, products, notes, remind_at AS "remindAt", status,
  notified_at AS "notifiedAt", created_at AS "createdAt", updated_at AS "updatedAt"`;
const uuid = (value) => z.string().uuid().safeParse(value).success;
const notFound = () => fail(404, 'Recordatorio no encontrado');

exports.normalizePhone = normalizePhone;

exports.list = async (organizationId, query = {}) => {
  const view = query.view || 'upcoming';
  if (!['upcoming', 'done', 'all'].includes(view)) fail(400, 'Filtro inválido');
  const where = view === 'all' ? '' : view === 'done' ? "AND status='done'" : "AND status='scheduled'";
  const order = view === 'upcoming' ? 'remind_at ASC' : 'remind_at DESC';
  return (await db.query(`SELECT ${columns} FROM reminders WHERE organization_id=$1 ${where} ORDER BY ${order}, created_at ASC LIMIT 500`, [organizationId])).rows;
};

exports.create = async (organizationId, userId, input) => {
  const value = parse(input);
  const result = await db.query(
    `INSERT INTO reminders (organization_id, contact_name, phone, products, notes, remind_at, created_by)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7) RETURNING ${columns}`,
    [organizationId, value.contactName, value.phone, JSON.stringify(value.products), value.notes || null, new Date(value.remindAt), userId || null],
  );
  return result.rows[0];
};

exports.update = async (organizationId, id, input) => {
  if (!uuid(id)) notFound();
  const value = parse(input);
  // Si cambia la hora, se vuelve a avisar en el chat interno.
  const result = await db.query(
    `UPDATE reminders SET contact_name=$3, phone=$4, products=$5::jsonb, notes=$6,
       notified_at = CASE WHEN remind_at = $7 THEN notified_at ELSE NULL END,
       remind_at=$7, updated_at=now()
     WHERE id=$1 AND organization_id=$2 RETURNING ${columns}`,
    [id, organizationId, value.contactName, value.phone, JSON.stringify(value.products), value.notes || null, new Date(value.remindAt)],
  );
  return result.rows[0] || notFound();
};

exports.setStatus = async (organizationId, id, input) => {
  if (!uuid(id)) notFound();
  const status = input?.status;
  if (!STATUSES.includes(status)) fail(400, 'Estado inválido');
  const result = await db.query(`UPDATE reminders SET status=$3, updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING ${columns}`, [id, organizationId, status]);
  return result.rows[0] || notFound();
};

exports.remove = async (organizationId, id) => {
  if (!uuid(id)) notFound();
  const result = await db.query('DELETE FROM reminders WHERE id=$1 AND organization_id=$2 RETURNING id', [id, organizationId]);
  if (!result.rows[0]) notFound();
  return { id };
};

/** «+52 272 123 4567» para leerlo fácil en el chat. */
const phoneLabel = (phone) => {
  const digits = String(phone || '');
  if (digits.length < 11) return digits;
  const local = digits.slice(-10);
  return `+${digits.slice(0, -10)} ${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;
};
const productLines = (products) => (Array.isArray(products) ? products : []).map((item) => `• ${item.quantity} × ${item.name}`);
/** Texto del aviso en el chat interno. */
exports.reminderBody = (reminder) => [
  `⏰ Es hora de escribirle a ${reminder.contactName} (${phoneLabel(reminder.phone)}).`,
  ...(reminder.products?.length ? ['', 'Quiere comprar:', ...productLines(reminder.products)] : []),
  ...(reminder.notes ? ['', `Notas: ${reminder.notes}`] : []),
].join('\n');

/**
 * Publica en el chat interno los recordatorios que ya llegaron a su hora. Se pueden
 * llamar varios procesos a la vez: cada recordatorio se reclama una sola vez.
 * Devuelve las organizaciones con avisos nuevos.
 */
exports.deliverDue = async (organizationId = null, limit = 100) => db.transaction(async (client) => {
  const claimed = (await client.query(
    `UPDATE reminders SET notified_at=now(), updated_at=now()
     WHERE id IN (
       SELECT id FROM reminders
       WHERE status='scheduled' AND notified_at IS NULL AND remind_at <= now() ${organizationId ? 'AND organization_id=$2' : ''}
       ORDER BY remind_at LIMIT $1 FOR UPDATE SKIP LOCKED
     )
     RETURNING id, organization_id AS "organizationId", contact_name AS "contactName", phone, products, notes, remind_at AS "remindAt"`,
    organizationId ? [limit, organizationId] : [limit],
  )).rows;
  for (const reminder of claimed) {
    const payload = { contactName: reminder.contactName, phone: reminder.phone, products: reminder.products || [], notes: reminder.notes || null, remindAt: reminder.remindAt };
    await client.query(
      `INSERT INTO internal_messages (organization_id, kind, body, reminder_id, payload) VALUES ($1,'reminder',$2,$3,$4::jsonb)`,
      [reminder.organizationId, exports.reminderBody(reminder), reminder.id, JSON.stringify(payload)],
    );
  }
  return [...new Set(claimed.map((reminder) => reminder.organizationId))];
});
