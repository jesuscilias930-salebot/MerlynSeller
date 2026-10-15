const { z } = require('zod');
const db = require('../lib/db');
const options = require('./interactive-options');

const nameSchema = z.string().trim().min(1, 'El nombre es obligatorio.').max(120, 'El nombre admite máximo 120 caracteres.');
const notFound = () => { const error = new Error('Mensaje con opciones no encontrado.'); error.status = 404; return error; };

const response = (row) => ({
  id: row.id, name: row.name, format: row.format, header: row.header || undefined, body: row.body,
  footer: row.footer || undefined, buttonText: row.button_text || undefined, sectionTitle: row.section_title || undefined,
  options: row.options, created_at: row.created_at, updated_at: row.updated_at,
});

const validate = (input = {}) => {
  const name = nameSchema.safeParse(input.name);
  if (!name.success) { const error = new Error(name.error.issues[0].message); error.status = 400; throw error; }
  return { name: name.data, ...options.normalize(input) };
};
const values = (value) => [value.name, value.format, value.header || null, value.body, value.footer || null, value.buttonText || null, value.sectionTitle || null, JSON.stringify(value.options)];

exports.list = async (organizationId) => (await db.query(
  'SELECT * FROM interactive_option_templates WHERE organization_id=$1 ORDER BY updated_at DESC', [organizationId],
)).rows.map(response);

exports.create = async (organizationId, input) => {
  const value = validate(input);
  const result = await db.query(
    'INSERT INTO interactive_option_templates (organization_id,name,format,header,body,footer,button_text,section_title,options) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *',
    [organizationId, ...values(value)],
  );
  return response(result.rows[0]);
};

exports.update = async (organizationId, id, input) => {
  const value = validate(input);
  const result = await db.query(
    'UPDATE interactive_option_templates SET name=$3,format=$4,header=$5,body=$6,footer=$7,button_text=$8,section_title=$9,options=$10::jsonb,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *',
    [id, organizationId, ...values(value)],
  );
  if (!result.rows[0]) throw notFound();
  return response(result.rows[0]);
};

exports.remove = async (organizationId, id) => {
  const result = await db.query('DELETE FROM interactive_option_templates WHERE id=$1 AND organization_id=$2 RETURNING id', [id, organizationId]);
  if (!result.rows[0]) throw notFound();
  return { deleted: true };
};
