const { z } = require('zod');
const db = require('../lib/db');

// Prendas tomadas temporalmente: cuántas, dónde están, quién las tomó y cuándo regresan.
// Solo es un aviso; la existencia de Control de ventas no cambia.
const text = (label, max, required = false) => z.union([z.string(), z.null()]).optional()
  .transform((value) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '') || null)
  .refine((value) => !required || value !== null, `Escribe ${label}`)
  .refine((value) => value === null || value.length <= max, `${label[0].toUpperCase()}${label.slice(1)} admite máximo ${max} caracteres`);
const schema = z.object({
  productId: z.number().int().positive('Selecciona el producto'),
  productName: text('el nombre del producto', 200, true),
  quantity: z.number().int().min(1, 'La cantidad mínima es 1').max(100000, 'Cantidad demasiado grande'),
  location: text('dónde están las prendas', 80, true),
  takenBy: text('quién las tomó', 60),
  returnDate: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha de regreso inválida'), z.literal(''), z.null()]).optional().transform((value) => value || null),
  notes: text('la nota', 300),
});
const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };
const parse = (input) => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) fail(400, parsed.error.issues[0].message);
  return parsed.data;
};
const uuid = (value) => z.string().uuid().safeParse(value).success;
const COLUMNS = `id, product_id AS "productId", product_name AS "productName", quantity, location, taken_by AS "takenBy", to_char(return_date, 'YYYY-MM-DD') AS "returnDate",
  notes, status, created_at AS "createdAt", returned_at AS "returnedAt"`;

/** Salidas abiertas (por defecto) o el historial reciente con `all`. */
exports.list = async (organizationId, query = {}) => {
  const all = query.status === 'all';
  return (await db.query(
    `SELECT ${COLUMNS} FROM inventory_loans WHERE organization_id=$1 ${all ? '' : "AND status='out'"}
     ORDER BY status, return_date NULLS LAST, created_at DESC LIMIT 500`,
    [organizationId],
  )).rows;
};

exports.create = async (organizationId, userId, input) => {
  const value = parse(input);
  return (await db.query(
    `INSERT INTO inventory_loans (organization_id, product_id, product_name, quantity, location, taken_by, return_date, notes, created_by)
     VALUES ($1,$2,$9,$3,$4,$5,$6,$7,$8) RETURNING ${COLUMNS}`,
    [organizationId, value.productId, value.quantity, value.location, value.takenBy, value.returnDate, value.notes, uuid(userId) ? userId : null, value.productName],
  )).rows[0];
};

exports.update = async (organizationId, id, input) => {
  if (!uuid(id)) fail(404, 'Salida no encontrada');
  const value = parse(input);
  const row = (await db.query(
    `UPDATE inventory_loans SET quantity=$3, location=$4, taken_by=$5, return_date=$6, notes=$7, updated_at=now()
     WHERE id=$1 AND organization_id=$2 AND product_id=$8 AND status='out' RETURNING ${COLUMNS}`,
    [id, organizationId, value.quantity, value.location, value.takenBy, value.returnDate, value.notes, value.productId],
  )).rows[0];
  if (!row) fail(404, 'Salida no encontrada o ya regresó');
  return row;
};

/** Regresaron todas, o solo algunas: las demás siguen fuera. */
exports.returnItems = async (organizationId, id, input = {}) => {
  if (!uuid(id)) fail(404, 'Salida no encontrada');
  const quantity = input.quantity == null ? null : Number(input.quantity);
  if (quantity !== null && (!Number.isInteger(quantity) || quantity < 1)) fail(400, 'Indica cuántas prendas regresaron');
  return db.transaction(async (client) => {
    const current = (await client.query(`SELECT ${COLUMNS} FROM inventory_loans WHERE id=$1 AND organization_id=$2 AND status='out' FOR UPDATE`, [id, organizationId])).rows[0];
    if (!current) fail(404, 'Salida no encontrada o ya regresó');
    if (quantity !== null && quantity > current.quantity) fail(400, `Solo hay ${current.quantity} fuera`);
    if (quantity === null || quantity === current.quantity) {
      return (await client.query(`UPDATE inventory_loans SET status='returned', returned_at=now(), updated_at=now() WHERE id=$1 RETURNING ${COLUMNS}`, [id])).rows[0];
    }
    // Se registra lo que regresó como su propia salida cerrada y se descuenta de la abierta.
    await client.query(
      `INSERT INTO inventory_loans (organization_id, product_id, product_name, quantity, location, taken_by, return_date, notes, status, returned_at, created_by, created_at)
       SELECT organization_id, product_id, product_name, $2, location, taken_by, return_date, notes, 'returned', now(), created_by, created_at FROM inventory_loans WHERE id=$1`,
      [id, quantity],
    );
    return (await client.query(`UPDATE inventory_loans SET quantity=quantity-$2, updated_at=now() WHERE id=$1 RETURNING ${COLUMNS}`, [id, quantity])).rows[0];
  });
};

exports.remove = async (organizationId, id) => {
  if (!uuid(id)) fail(404, 'Salida no encontrada');
  const deleted = await db.query('DELETE FROM inventory_loans WHERE id=$1 AND organization_id=$2 RETURNING id', [id, organizationId]);
  if (!deleted.rows[0]) fail(404, 'Salida no encontrada');
  return { id };
};
