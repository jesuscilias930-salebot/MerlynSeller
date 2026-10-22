const { z } = require('zod');
const db = require('../lib/db');

// Ubicaciones por talla y/o color dentro de un producto: se reemplaza la lista completa del producto.
const text = (max, label) => z.union([z.string(), z.null()]).optional()
  .transform((value) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '') || null)
  .refine((value) => value === null || value.length <= max, `${label} admite máximo ${max} caracteres`);
const slot = z.object({
  size: text(40, 'La talla'),
  color: text(40, 'El color'),
  quantity: z.union([z.number().int().min(0).max(1_000_000_000), z.null()]).optional().transform((value) => value ?? null),
  rack: text(30, 'El rack'),
  level: text(30, 'El piso'),
  side: text(30, 'El lado'),
});
const MAX_SLOTS = 100;
const fail = (message) => { const error = new Error(message); error.status = 400; throw error; };
const columns = 'product_id AS "productId", size, color, quantity, rack, level, side';

exports.list = async (organizationId) => (await db.query(
  `SELECT ${columns} FROM product_location_slots WHERE organization_id=$1 ORDER BY product_id, position`,
  [organizationId],
)).rows;

exports.replace = async (organizationId, productIdValue, input) => {
  const productId = Number(productIdValue);
  if (!Number.isInteger(productId) || productId < 1) fail('Producto inválido');
  const rows = input?.slots;
  if (!Array.isArray(rows)) fail('Indica la lista de ubicaciones');
  if (rows.length > MAX_SLOTS) fail(`Máximo ${MAX_SLOTS} ubicaciones por producto`);
  const slots = rows.map((row, index) => {
    const parsed = slot.safeParse(row || {});
    if (!parsed.success) fail(`Fila ${index + 1}: ${parsed.error.issues[0].message}`);
    const value = parsed.data;
    if (!value.size && !value.color) fail(`Fila ${index + 1}: indica la talla o el color`);
    if (!value.rack && !value.level && !value.side) fail(`Fila ${index + 1}: indica rack, piso o lado`);
    return value;
  });
  const keys = slots.map((value) => `${(value.size || '').toLowerCase()}|${(value.color || '').toLowerCase()}`);
  const repeated = keys.findIndex((key, index) => keys.indexOf(key) !== index);
  if (repeated >= 0) fail(`Fila ${repeated + 1}: esa talla y color ya están en otra fila`);
  return db.transaction(async (client) => {
    await client.query('DELETE FROM product_location_slots WHERE organization_id=$1 AND product_id=$2', [organizationId, productId]);
    const saved = [];
    for (const [position, value] of slots.entries()) {
      const result = await client.query(
        `INSERT INTO product_location_slots (organization_id, product_id, size, color, quantity, rack, level, side, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${columns}`,
        [organizationId, productId, value.size, value.color, value.quantity, value.rack, value.level, value.side, position],
      );
      saved.push(result.rows[0]);
    }
    return saved;
  });
};
