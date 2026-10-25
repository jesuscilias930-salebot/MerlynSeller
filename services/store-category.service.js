const { z } = require('zod');
const db = require('../lib/db');

// Secciones de la página de productos de la tienda: qué categorías de Control se muestran juntas y en qué orden.
const clean = (value) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '');
const row = z.object({
  categoryId: z.number().int().positive(),
  categoryName: z.string().transform(clean).refine((value) => value.length >= 1 && value.length <= 120, 'Nombre de categoría inválido'),
  section: z.string().transform(clean).refine((value) => value.length >= 1, 'Escribe en qué sección se muestra cada categoría')
    .refine((value) => value.length <= 60, 'El nombre de la sección admite máximo 60 caracteres'),
  position: z.number().int().min(0).max(999).default(0),
});
const schema = z.object({ categories: z.array(row).max(300, 'Máximo 300 categorías') });
const fail = (message) => { const error = new Error(message); error.status = 400; throw error; };
const COLUMNS = 'category_id AS "categoryId", category_name AS "categoryName", section, position';

exports.list = async (organizationId) => (await db.query(
  `SELECT ${COLUMNS} FROM store_category_sections WHERE organization_id=$1 ORDER BY position, section, category_name`, [organizationId],
)).rows;

/** Reemplaza la configuración completa. Una categoría cuya sección es su propio nombre en posición 0 no necesita guardarse. */
exports.save = async (organizationId, input) => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) fail(parsed.error.issues[0].message);
  const ids = parsed.data.categories.map((item) => item.categoryId);
  if (new Set(ids).size !== ids.length) fail('Hay categorías repetidas');
  const custom = parsed.data.categories.filter((item) => item.position !== 0 || item.section.toLocaleLowerCase('es-MX') !== item.categoryName.toLocaleLowerCase('es-MX'));
  return db.transaction(async (client) => {
    await client.query('DELETE FROM store_category_sections WHERE organization_id=$1', [organizationId]);
    for (const item of custom) {
      await client.query(
        'INSERT INTO store_category_sections (organization_id, category_id, category_name, section, position) VALUES ($1,$2,$3,$4,$5)',
        [organizationId, item.categoryId, item.categoryName, item.section, item.position],
      );
    }
    return (await client.query(`SELECT ${COLUMNS} FROM store_category_sections WHERE organization_id=$1 ORDER BY position, section, category_name`, [organizationId])).rows;
  });
};
