const { z } = require('zod');
const db = require('../lib/db');

// Venta pendiente de pago que nace con cada recordatorio. Se cierra a mano:
// pagada (registrada en Control de ventas, que descuenta el stock) o cancelada.
// Si se cierra antes de que llegue el recordatorio, el recordatorio se cancela.
const PAYMENT_METHODS = ['cash', 'transfer', 'card', 'deposit', 'other'];
const STATUSES = ['open', 'paid', 'cancelled'];
const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };
const line = z.object({
  kind: z.enum(['product', 'bundle', 'custom']),
  id: z.number().int().positive().optional(),
  name: z.string().trim().min(1, 'Cada producto necesita nombre').max(160),
  quantity: z.number().int().min(1, 'La cantidad mínima es 1').max(100000),
}).refine((item) => item.kind === 'custom' || item.id, 'Selecciona un producto del inventario');
const paySchema = z.object({
  amount: z.union([z.number(), z.string()]).transform((value) => Number(value)).refine((value) => Number.isFinite(value) && value > 0 && value < 10_000_000, 'Indica un monto mayor a 0'),
  paymentMethod: z.enum(PAYMENT_METHODS, { message: 'Elige el tipo de pago' }),
  items: z.array(line).min(1, 'Agrega al menos un producto vendido').max(30),
  controlSaleId: z.number().int().positive('Falta el número de venta de Control'),
});
const uuid = (value) => z.string().uuid().safeParse(value).success;
const notFound = () => fail(404, 'Venta no encontrada');

const columns = `s.id, s.conversation_id AS "conversationId", s.contact_name AS "contactName", s.phone, s.items, s.status,
  s.amount::text AS amount, s.payment_method AS "paymentMethod", s.paid_items AS "paidItems", s.control_sale_id AS "controlSaleId",
  s.closed_at AS "closedAt", s.created_at AS "createdAt", s.updated_at AS "updatedAt",
  r.id AS "reminderId", r.remind_at AS "reminderAt", r.status AS "reminderStatus", r.notified_at AS "reminderNotifiedAt", r.send_mode AS "reminderMode"`;
const from = `pending_sales s LEFT JOIN LATERAL (SELECT id, remind_at, status, notified_at, send_mode FROM reminders WHERE sale_id = s.id ORDER BY created_at LIMIT 1) r ON true`;
const byId = async (organizationId, id) => (await db.query(`SELECT ${columns} FROM ${from} WHERE s.id=$1 AND s.organization_id=$2`, [id, organizationId])).rows[0];

exports.PAYMENT_METHODS = PAYMENT_METHODS;
exports.list = async (organizationId, query = {}) => {
  const status = query.status || 'open';
  if (status !== 'all' && !STATUSES.includes(status)) fail(400, 'Estado inválido');
  const values = [organizationId];
  if (status !== 'all') values.push(status);
  return (await db.query(
    `SELECT ${columns} FROM ${from} WHERE s.organization_id=$1 ${status !== 'all' ? 'AND s.status=$2' : ''} ORDER BY COALESCE(s.closed_at, s.created_at) DESC LIMIT 500`,
    values,
  )).rows;
};

/** Cierra el recordatorio de la venta: cancelado si aún no llegaba su hora, hecho si ya se avisó. */
const closeReminder = (organizationId, saleId, client = db) => client.query(
  `UPDATE reminders SET status = CASE WHEN notified_at IS NULL THEN 'cancelled' ELSE 'done' END, updated_at=now()
   WHERE sale_id=$1 AND organization_id=$2 AND status='scheduled' RETURNING id, status`,
  [saleId, organizationId],
);
exports.closeReminder = closeReminder;

exports.pay = async (organizationId, id, input) => {
  if (!uuid(id)) notFound();
  const parsed = paySchema.safeParse(input || {});
  if (!parsed.success) fail(400, parsed.error.issues[0].message);
  const value = parsed.data;
  // Reintentar con el mismo número de venta de Control solo liga, no cobra otra vez.
  const updated = await db.query(
    `UPDATE pending_sales SET status='paid', amount=$3, payment_method=$4, paid_items=$5::jsonb, control_sale_id=$6, closed_at=COALESCE(closed_at, now()), updated_at=now()
     WHERE id=$1 AND organization_id=$2 AND (status='open' OR (status='paid' AND control_sale_id=$6)) RETURNING id`,
    [id, organizationId, value.amount.toFixed(2), value.paymentMethod, JSON.stringify(value.items), value.controlSaleId],
  ).catch((error) => { if (error.code === '23505') fail(409, `La venta #${value.controlSaleId} de Control ya está ligada a otra venta pendiente`); throw error; });
  if (!updated.rows[0]) {
    const current = await byId(organizationId, id);
    if (!current) notFound();
    fail(409, current.status === 'cancelled' ? 'Esta venta se cerró sin pago; no se puede cobrar.' : `Esta venta ya se pagó (Control #${current.controlSaleId}).`);
  }
  await closeReminder(organizationId, id);
  return byId(organizationId, id);
};

exports.cancel = async (organizationId, id) => {
  if (!uuid(id)) notFound();
  const updated = await db.query(
    "UPDATE pending_sales SET status='cancelled', closed_at=now(), updated_at=now() WHERE id=$1 AND organization_id=$2 AND status='open' RETURNING id",
    [id, organizationId],
  );
  if (!updated.rows[0]) {
    if (!(await byId(organizationId, id))) notFound();
    fail(409, 'Solo se pueden cerrar ventas pendientes de pago.');
  }
  await closeReminder(organizationId, id);
  return byId(organizationId, id);
};
