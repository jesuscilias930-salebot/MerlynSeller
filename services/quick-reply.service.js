const { z } = require('zod');
const db = require('../lib/db');

const schema = z.object({
  shortcut: z.string().trim().toLowerCase().regex(/^\/[a-z0-9_]{1,40}$/, 'El atajo debe iniciar con / y usar solo letras, números o guion bajo.'),
  name: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(4096),
});

const parse = (input) => {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const error = new Error(result.error.issues[0].message); error.status = 400; throw error;
};

exports.list = async (organizationId) => (await db.query(
  'SELECT id, shortcut, name, body, created_at, updated_at FROM quick_replies WHERE organization_id=$1 ORDER BY shortcut ASC',
  [organizationId],
)).rows;

exports.create = async (organizationId, input) => {
  const value = parse(input);
  try {
    return (await db.query(
      'INSERT INTO quick_replies (organization_id, shortcut, name, body) VALUES ($1,$2,$3,$4) RETURNING id, shortcut, name, body, created_at, updated_at',
      [organizationId, value.shortcut, value.name, value.body],
    )).rows[0];
  } catch (error) {
    if (error.code === '23505') { error.status = 409; error.message = 'Ya existe una respuesta rápida con ese atajo.'; }
    throw error;
  }
};

exports.update = async (organizationId, id, input) => {
  const value = parse(input);
  try {
    const result = await db.query(
      'UPDATE quick_replies SET shortcut=$3, name=$4, body=$5, updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING id, shortcut, name, body, created_at, updated_at',
      [id, organizationId, value.shortcut, value.name, value.body],
    );
    if (!result.rows[0]) { const error = new Error('Respuesta rápida no encontrada.'); error.status = 404; throw error; }
    return result.rows[0];
  } catch (error) {
    if (error.code === '23505') { error.status = 409; error.message = 'Ya existe una respuesta rápida con ese atajo.'; }
    throw error;
  }
};

exports.remove = async (organizationId, id) => {
  const result = await db.query('DELETE FROM quick_replies WHERE id=$1 AND organization_id=$2 RETURNING id', [id, organizationId]);
  if (!result.rows[0]) { const error = new Error('Respuesta rápida no encontrada.'); error.status = 404; throw error; }
  return { deleted: true };
};
