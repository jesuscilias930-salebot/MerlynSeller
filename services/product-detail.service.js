const { z } = require('zod');
const db = require('../lib/db');

// Color opcional de los productos de Control de ventas (por organización y número de producto).
const schema = z.object({
  color: z.union([z.string(), z.null()]).optional()
    .transform((value) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '') || null)
    .refine((value) => value === null || value.length <= 40, 'El color admite máximo 40 caracteres'),
});
const fail = (message) => { const error = new Error(message); error.status = 400; throw error; };

exports.list = async (organizationId) => (await db.query(
  'SELECT product_id AS "productId", color FROM product_details WHERE organization_id=$1 AND color IS NOT NULL ORDER BY product_id',
  [organizationId],
)).rows;

exports.save = async (organizationId, productId, input) => {
  const id = Number(productId);
  if (!Number.isInteger(id) || id < 1) fail('Producto inválido');
  const parsed = schema.safeParse(input || {});
  if (!parsed.success) fail(parsed.error.issues[0].message);
  const { color } = parsed.data;
  if (!color) {
    await db.query('DELETE FROM product_details WHERE organization_id=$1 AND product_id=$2', [organizationId, id]);
    return { productId: id, color: null };
  }
  const result = await db.query(
    `INSERT INTO product_details (organization_id, product_id, color) VALUES ($1,$2,$3)
     ON CONFLICT (organization_id, product_id) DO UPDATE SET color=EXCLUDED.color, updated_at=now()
     RETURNING product_id AS "productId", color`,
    [organizationId, id, color],
  );
  return result.rows[0];
};
