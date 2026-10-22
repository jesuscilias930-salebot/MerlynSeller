const { z } = require('zod');
const db = require('../lib/db');

// Ubicación en bodega (rack, piso y lado) de los productos de Control de ventas.
// Se guarda por organización y número de producto; una ubicación vacía se borra.
const field = (label) => z.union([z.string(), z.null()]).optional()
  .transform((value) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '') || null)
  .refine((value) => value === null || value.length <= 30, `${label} admite máximo 30 caracteres`);
const schema = z.object({
  productIds: z.array(z.number().int().positive()).min(1, 'Selecciona al menos un producto').max(200, 'Máximo 200 productos a la vez'),
  rack: field('El rack'),
  level: field('El piso'),
  side: field('El lado'),
});
const fail = (message) => { const error = new Error(message); error.status = 400; throw error; };

exports.list = async (organizationId) => (await db.query(
  'SELECT product_id AS "productId", rack, level, side, updated_at AS "updatedAt" FROM product_locations WHERE organization_id=$1 ORDER BY product_id',
  [organizationId],
)).rows;

exports.save = async (organizationId, input) => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) fail(parsed.error.issues[0].message);
  const { productIds, rack, level, side } = parsed.data;
  const ids = [...new Set(productIds)];
  if (!rack && !level && !side) {
    await db.query('DELETE FROM product_locations WHERE organization_id=$1 AND product_id = ANY($2::int[])', [organizationId, ids]);
    return ids.map((productId) => ({ productId, rack: null, level: null, side: null }));
  }
  const result = await db.query(
    `INSERT INTO product_locations (organization_id, product_id, rack, level, side)
     SELECT $1, id, $3, $4, $5 FROM unnest($2::int[]) AS id
     ON CONFLICT (organization_id, product_id) DO UPDATE SET rack=EXCLUDED.rack, level=EXCLUDED.level, side=EXCLUDED.side, updated_at=now()
     RETURNING product_id AS "productId", rack, level, side, updated_at AS "updatedAt"`,
    [organizationId, ids, rack, level, side],
  );
  return result.rows;
};
