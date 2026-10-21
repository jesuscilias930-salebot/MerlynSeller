const { z } = require('zod');
const db = require('../lib/db');

// Entregas agendadas desde el inbox o desde WhatsApp → Entregas. La venta en
// persona guarda aquí monto y forma de pago; el stock lo descuenta Control de
// ventas (su id de venta se guarda para no registrar dos veces).
const PAYMENT_METHODS = ['cash', 'transfer', 'card', 'deposit', 'other'];
const STATUSES = ['scheduled', 'delivered', 'cancelled'];
const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };
const text = (max, label) => z.string().trim().max(max, `${label} admite máximo ${max} caracteres`);
const line = z.object({
  kind: z.enum(['product', 'bundle', 'custom']),
  id: z.number().int().positive().optional(),
  name: z.string().trim().min(1, 'Cada producto necesita nombre').max(160),
  quantity: z.number().int().min(1, 'La cantidad mínima es 1').max(100000),
}).refine((item) => item.kind === 'custom' || item.id, 'Selecciona un producto del inventario');
const dateTime = z.string().trim().refine((value) => !Number.isNaN(Date.parse(value)), 'Indica una fecha y hora válidas');

const appointmentSchema = z.object({
  conversationId: z.string().uuid().nullable().optional(),
  customerName: text(120, 'El nombre').min(1, 'Escribe el nombre del cliente'),
  customerPhone: z.string().trim().max(20).regex(/^[\d +()-]*$/, 'El teléfono solo admite números').optional().nullable(),
  location: text(300, 'El lugar').min(1, 'Escribe el lugar de entrega'),
  scheduledAt: dateTime,
  products: z.array(line).max(30, 'Máximo 30 productos').default([]),
  notes: text(2000, 'Las notas').optional().nullable(),
});
const saleSchema = z.object({
  amount: z.union([z.number(), z.string()]).transform((value) => Number(value)).refine((value) => Number.isFinite(value) && value > 0 && value < 10_000_000, 'Indica un monto mayor a 0'),
  paymentMethod: z.enum(PAYMENT_METHODS, { message: 'Elige el tipo de pago' }),
  items: z.array(line).min(1, 'Agrega al menos un producto vendido').max(30),
  controlSaleId: z.number().int().positive('Falta el número de venta de Control'),
  markDelivered: z.boolean().default(true),
});
const parse = (schema, input) => {
  const result = schema.safeParse(input);
  if (!result.success) fail(400, result.error.issues[0].message);
  return result.data;
};

const columns = `id, conversation_id AS "conversationId", customer_name AS "customerName", customer_phone AS "customerPhone",
  location, scheduled_at AS "scheduledAt", products, notes, status,
  sale_amount::text AS "saleAmount", sale_payment_method AS "salePaymentMethod", sale_items AS "saleItems",
  control_sale_id AS "controlSaleId", sale_recorded_at AS "saleRecordedAt", created_at AS "createdAt", updated_at AS "updatedAt"`;
const notFound = () => fail(404, 'Entrega no encontrada');
const uuid = (value) => z.string().uuid().safeParse(value).success;

const ensureConversation = async (organizationId, conversationId) => {
  if (!conversationId) return;
  const found = await db.query('SELECT 1 FROM conversations WHERE id=$1 AND organization_id=$2', [conversationId, organizationId]);
  if (!found.rows[0]) fail(400, 'La conversación no pertenece a tu negocio');
};

exports.PAYMENT_METHODS = PAYMENT_METHODS;
exports.list = async (organizationId, query = {}) => {
  const where = ['organization_id=$1'];
  const values = [organizationId];
  if (query.conversationId) { if (!uuid(query.conversationId)) fail(400, 'Conversación inválida'); values.push(query.conversationId); where.push(`conversation_id=$${values.length}`); }
  if (query.from) { if (Number.isNaN(Date.parse(query.from))) fail(400, 'Fecha inicial inválida'); values.push(query.from); where.push(`scheduled_at >= $${values.length}`); }
  if (query.to) { if (Number.isNaN(Date.parse(query.to))) fail(400, 'Fecha final inválida'); values.push(query.to); where.push(`scheduled_at < $${values.length}`); }
  if (query.status) { if (!STATUSES.includes(query.status)) fail(400, 'Estado inválido'); values.push(query.status); where.push(`status=$${values.length}`); }
  const order = query.order === 'desc' ? 'DESC' : 'ASC';
  return (await db.query(`SELECT ${columns} FROM delivery_appointments WHERE ${where.join(' AND ')} ORDER BY scheduled_at ${order}, created_at ASC LIMIT 500`, values)).rows;
};

exports.create = async (organizationId, input) => {
  const value = parse(appointmentSchema, input);
  await ensureConversation(organizationId, value.conversationId);
  const result = await db.query(
    `INSERT INTO delivery_appointments (organization_id, conversation_id, customer_name, customer_phone, location, scheduled_at, products, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING ${columns}`,
    [organizationId, value.conversationId || null, value.customerName, value.customerPhone || null, value.location, new Date(value.scheduledAt), JSON.stringify(value.products), value.notes || null],
  );
  return result.rows[0];
};

exports.update = async (organizationId, id, input) => {
  if (!uuid(id)) notFound();
  const value = parse(appointmentSchema, input);
  await ensureConversation(organizationId, value.conversationId);
  const result = await db.query(
    `UPDATE delivery_appointments SET conversation_id=$3, customer_name=$4, customer_phone=$5, location=$6, scheduled_at=$7, products=$8::jsonb, notes=$9, updated_at=now()
     WHERE id=$1 AND organization_id=$2 RETURNING ${columns}`,
    [id, organizationId, value.conversationId || null, value.customerName, value.customerPhone || null, value.location, new Date(value.scheduledAt), JSON.stringify(value.products), value.notes || null],
  );
  return result.rows[0] || notFound();
};

exports.setStatus = async (organizationId, id, input) => {
  if (!uuid(id)) notFound();
  const status = parse(z.object({ status: z.enum(STATUSES) }), input).status;
  const current = (await db.query('SELECT sale_recorded_at FROM delivery_appointments WHERE id=$1 AND organization_id=$2', [id, organizationId])).rows[0];
  if (!current) notFound();
  if (status === 'cancelled' && current.sale_recorded_at) fail(409, 'No se puede cancelar una entrega con venta registrada');
  const result = await db.query(`UPDATE delivery_appointments SET status=$3, updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING ${columns}`, [id, organizationId, status]);
  return result.rows[0];
};

exports.recordSale = async (organizationId, id, input) => {
  if (!uuid(id)) notFound();
  const value = parse(saleSchema, input);
  if (value.items.some((item) => item.kind === 'custom')) fail(400, 'La venta solo admite productos o bundles del inventario');
  try {
    // Solo la primera vez: una entrega no puede tener dos ventas.
    const result = await db.query(
      `UPDATE delivery_appointments SET sale_amount=$3, sale_payment_method=$4, sale_items=$5::jsonb, control_sale_id=$6, sale_recorded_at=now(),
         status=CASE WHEN $7 THEN 'delivered' ELSE status END, updated_at=now()
       WHERE id=$1 AND organization_id=$2 AND sale_recorded_at IS NULL AND status <> 'cancelled' RETURNING ${columns}`,
      [id, organizationId, value.amount.toFixed(2), value.paymentMethod, JSON.stringify(value.items), value.controlSaleId, value.markDelivered],
    );
    if (result.rows[0]) return result.rows[0];
  } catch (error) {
    if (error.code === '23505') fail(409, 'Esa venta de Control ya está ligada a otra entrega');
    throw error;
  }
  const current = (await db.query('SELECT status, sale_recorded_at FROM delivery_appointments WHERE id=$1 AND organization_id=$2', [id, organizationId])).rows[0];
  if (!current) notFound();
  if (current.sale_recorded_at) fail(409, 'Esta entrega ya tiene una venta registrada');
  return fail(409, 'No se puede registrar venta en una entrega cancelada');
};

exports.remove = async (organizationId, id) => {
  if (!uuid(id)) notFound();
  const result = await db.query('DELETE FROM delivery_appointments WHERE id=$1 AND organization_id=$2 AND sale_recorded_at IS NULL RETURNING id', [id, organizationId]);
  if (result.rows[0]) return { deleted: true };
  const exists = await db.query('SELECT 1 FROM delivery_appointments WHERE id=$1 AND organization_id=$2', [id, organizationId]);
  if (!exists.rows[0]) notFound();
  return fail(409, 'No se puede eliminar una entrega con venta registrada');
};
