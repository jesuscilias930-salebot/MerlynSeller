const { z } = require('zod');
const db = require('../lib/db');

// Datos de productos de Control de ventas que viven en el CRM (por organización y número de producto):
// color opcional y modelo que agrupa variantes de color y talla.
const text = (max, label) => z.union([z.string(), z.null()]).optional()
  .transform((value) => (value === undefined ? undefined : (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '') || null))
  .refine((value) => value == null || value.length <= max, `${label} admite máximo ${max} caracteres`);
const detail = z.object({ color: text(40, 'El color'), model: text(80, 'El modelo') });
const MAX_ITEMS = 300;
const fail = (message) => { const error = new Error(message); error.status = 400; throw error; };
const productId = (value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) fail('Producto inválido');
  return id;
};
const parse = (input) => {
  const parsed = detail.safeParse(input || {});
  if (!parsed.success) fail(parsed.error.issues[0].message);
  return parsed.data;
};

exports.list = async (organizationId) => (await db.query(
  `SELECT product_id AS "productId", color, model FROM product_details
   WHERE organization_id=$1 AND (color IS NOT NULL OR model IS NOT NULL) ORDER BY product_id`,
  [organizationId],
)).rows;

// Un campo ausente conserva su valor; null o texto vacío lo borra. Sin color ni modelo, la fila se elimina.
const upsert = async (client, organizationId, id, { color, model }) => {
  const result = await client.query(
    `INSERT INTO product_details (organization_id, product_id, color, model) VALUES ($1,$2,$3,$4)
     ON CONFLICT (organization_id, product_id) DO UPDATE SET
       color = CASE WHEN $5 THEN EXCLUDED.color ELSE product_details.color END,
       model = CASE WHEN $6 THEN EXCLUDED.model ELSE product_details.model END,
       updated_at = now()
     RETURNING product_id AS "productId", color, model`,
    [organizationId, id, color ?? null, model ?? null, color !== undefined, model !== undefined],
  );
  const row = result.rows[0] || { productId: id, color: color ?? null, model: model ?? null };
  if (!row.color && !row.model) {
    await client.query('DELETE FROM product_details WHERE organization_id=$1 AND product_id=$2 AND color IS NULL AND model IS NULL', [organizationId, id]);
    return { productId: id, color: null, model: null };
  }
  return row;
};

exports.save = async (organizationId, id, input) => {
  const productIdValue = productId(id);
  const data = parse(input);
  return db.transaction((client) => upsert(client, organizationId, productIdValue, data));
};

exports.saveMany = async (organizationId, items) => {
  if (!Array.isArray(items) || !items.length) fail('Indica al menos un producto');
  if (items.length > MAX_ITEMS) fail(`Máximo ${MAX_ITEMS} productos por operación`);
  const parsed = items.map((item) => ({ id: productId(item?.productId), data: parse(item) }));
  if (new Set(parsed.map((item) => item.id)).size !== parsed.length) fail('Un producto aparece dos veces');
  return db.transaction(async (client) => {
    const saved = [];
    for (const item of parsed) saved.push(await upsert(client, organizationId, item.id, item.data));
    return saved;
  });
};
