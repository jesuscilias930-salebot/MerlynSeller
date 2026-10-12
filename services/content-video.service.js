const { z } = require('zod');
const db = require('../lib/db');

const fail = (status, message) => Object.assign(new Error(message), { status });
function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) throw fail(400, result.error.issues[0].message);
  return result.data;
}
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Usa una fecha válida.').refine(value => {
  const parsed = new Date(`${value}T12:00:00Z`);
  return value >= '1900-01-01' && value <= '9999-12-31' && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Usa una fecha válida.').nullable().default(null);
const text = (max) => z.string().trim().max(max, `El texto no puede exceder ${max} caracteres.`).default('');
const fields = {
  channel: z.enum(['organic', 'ads'], { error: 'Selecciona Orgánico o Ads.' }),
  title: z.string().trim().min(1, 'Escribe un título para el video.').max(160, 'El título debe tener hasta 160 caracteres.'),
  script: text(20000), shots: text(10000), prompts: text(20000),
  recordingDate: date, publishingDate: date,
  isPublished: z.boolean().default(false), resultNotes: text(10000),
};
const createSchema = z.object(fields).strict();
const revision = z.number().int().positive().max(2147483646);
const updateSchema = z.object({ ...fields, revision }).strict();
const statusSchema = z.object({ isPublished: z.boolean(), revision }).strict();
const deleteSchema = z.object({ revision }).strict();
const idSchema = z.string().uuid('El identificador del video no es válido.');
const querySchema = z.object({
  channel: fields.channel,
  q: z.string().trim().max(120, 'La búsqueda debe tener hasta 120 caracteres.').default(''),
  status: z.enum(['all', 'pending', 'published']).default('all'),
  page: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(0).max(100000)).default(0),
  size: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(30)).default(12),
}).strict();
const columns = `id, channel, title, script, shots, prompts,
  to_char(recording_date, 'YYYY-MM-DD') AS "recordingDate",
  to_char(publishing_date, 'YYYY-MM-DD') AS "publishingDate",
  is_published AS "isPublished", result_notes AS "resultNotes", revision,
  created_at AS "createdAt", updated_at AS "updatedAt"`;
const values = (value) => [value.channel, value.title, value.script, value.shots, value.prompts,
  value.recordingDate, value.publishingDate, value.isPublished, value.resultNotes];

exports.list = async (organizationId, input) => {
  const value = parse(querySchema, input);
  // Escape LIKE wildcards as literals; every user value is a bound parameter.
  const q = value.q.replace(/[\\%_]/g, '\\$&');
  const args = [organizationId, value.channel, `%${q}%`, value.status === 'all' ? null : value.status === 'published'];
  const where = `organization_id=$1 AND channel=$2 AND title ILIKE $3 ESCAPE '\\' AND ($4::boolean IS NULL OR is_published=$4)`;
  const [rows, count, stats] = await Promise.all([
    db.query(`SELECT ${columns} FROM content_videos WHERE ${where}
      ORDER BY is_published ASC, publishing_date ASC NULLS LAST, created_at DESC, id
      LIMIT $5 OFFSET $6`, [...args, value.size, value.page * value.size]),
    db.query(`SELECT count(*)::int AS total FROM content_videos WHERE ${where}`, args),
    db.query(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE is_published)::int AS published,
      count(*) FILTER (WHERE NOT is_published)::int AS pending
      FROM content_videos WHERE organization_id=$1 AND channel=$2`, [organizationId, value.channel]),
  ]);
  return { items: rows.rows, total: count.rows[0].total, page: value.page, size: value.size, stats: stats.rows[0] };
};

exports.create = async (organizationId, input) => {
  const value = parse(createSchema, input);
  return (await db.query(`INSERT INTO content_videos
    (organization_id, channel, title, script, shots, prompts, recording_date, publishing_date, is_published, result_notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${columns}`, [organizationId, ...values(value)])).rows[0];
};

async function changed(organizationId, id, result) {
  if (result.rows[0]) return result.rows[0];
  const existing = await db.query('SELECT id FROM content_videos WHERE id=$1 AND organization_id=$2', [id, organizationId]);
  throw existing.rows[0] ? fail(409, 'Este video cambió en otra sesión. Actualiza la lista y vuelve a abrirlo antes de guardar.') : fail(404, 'Video no encontrado.');
}

exports.update = async (organizationId, rawId, input) => {
  const id = parse(idSchema, rawId), value = parse(updateSchema, input);
  const result = await db.query(`UPDATE content_videos SET channel=$3, title=$4, script=$5, shots=$6,
    prompts=$7, recording_date=$8, publishing_date=$9, is_published=$10, result_notes=$11,
    revision=revision+1, updated_at=now() WHERE id=$1 AND organization_id=$2 AND revision=$12
    RETURNING ${columns}`, [id, organizationId, ...values(value), value.revision]);
  return changed(organizationId, id, result);
};

exports.setPublished = async (organizationId, rawId, input) => {
  const id = parse(idSchema, rawId), value = parse(statusSchema, input);
  const result = await db.query(`UPDATE content_videos SET is_published=$3, revision=revision+1, updated_at=now()
    WHERE id=$1 AND organization_id=$2 AND revision=$4 RETURNING ${columns}`, [id, organizationId, value.isPublished, value.revision]);
  return changed(organizationId, id, result);
};

exports.remove = async (organizationId, rawId, input) => {
  const id = parse(idSchema, rawId), value = parse(deleteSchema, input);
  const result = await db.query('DELETE FROM content_videos WHERE id=$1 AND organization_id=$2 AND revision=$3 RETURNING id', [id, organizationId, value.revision]);
  await changed(organizationId, id, result);
  return { deleted: true };
};
