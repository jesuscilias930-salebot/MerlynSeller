const { z } = require('zod');
const db = require('../lib/db');
const messageService = require('./message.service');

// Meta conserva los archivos 30 días; se reutilizan hasta 25 para no mandar uno vencido.
const REUSE_DAYS = 25;
const fail = (status, message) => Object.assign(new Error(message), { status });
const sha256Schema = z.string().trim().toLowerCase().regex(/^[a-f0-9]{64}$/);
const caption = z.string().trim().max(1024).optional();

exports.REUSE_DAYS = REUSE_DAYS;
exports.parseSha256 = (value) => { const parsed = sha256Schema.safeParse(value); return parsed.success ? parsed.data : null; };

/** Archivo de Meta aún vigente para ese video (misma huella), o null. */
exports.cachedMediaId = async (organizationId, sha256) => {
  const hash = exports.parseSha256(sha256);
  if (!hash) return null;
  const row = (await db.query(
    `SELECT media_id FROM video_media_cache WHERE organization_id=$1 AND sha256=$2 AND uploaded_at > now() - ($3 || ' days')::interval`,
    [organizationId, hash, String(REUSE_DAYS)],
  )).rows[0];
  return row?.media_id || null;
};

exports.remember = async (organizationId, sha256, mediaId, bytes) => {
  const hash = exports.parseSha256(sha256);
  if (!hash || !mediaId) return;
  await db.query(
    `INSERT INTO video_media_cache (organization_id, sha256, media_id, bytes) VALUES ($1,$2,$3,$4)
     ON CONFLICT (organization_id, sha256) DO UPDATE SET media_id=EXCLUDED.media_id, bytes=EXCLUDED.bytes, uploaded_at=now()`,
    [organizationId, hash, mediaId, bytes || null],
  );
};

/** Envía sin subir nada si ese mismo video ya se mandó hace menos de 25 días. */
exports.queueCached = async (organizationId, conversationId, input = {}) => {
  const hash = exports.parseSha256(input.sha256);
  if (!hash) throw fail(400, 'Huella del video inválida.');
  const text = caption.safeParse(input.caption || undefined);
  if (!text.success) throw fail(400, 'El texto del video puede tener hasta 1024 caracteres.');
  const mediaId = await exports.cachedMediaId(organizationId, hash);
  if (!mediaId) return { cached: false };
  const queued = await require('./conversation.service').queueExistingMedia(organizationId, conversationId, 'video', mediaId, text.data);
  console.log(JSON.stringify({ level: 'info', message: 'Video reused from cache', conversationId }));
  return { cached: true, ...queued };
};

// ——— Videos guardados ———
const nameSchema = z.string().trim().min(1, 'Ponle un nombre al video.').max(120, 'El nombre puede tener hasta 120 caracteres.');
const updateSchema = z.object({ name: nameSchema.optional(), chatShortcut: z.boolean().optional() }).strict();
const row = (value) => ({ id: value.id, name: value.name, filename: value.filename, bytes: value.bytes, chatShortcut: value.chat_shortcut, position: value.position, createdAt: value.created_at, updatedAt: value.updated_at });
const COLUMNS = 'id, name, filename, bytes, chat_shortcut, position, created_at, updated_at';

exports.list = async (organizationId) => (await db.query(
  `SELECT ${COLUMNS} FROM saved_videos WHERE organization_id=$1 ORDER BY position, created_at`, [organizationId],
)).rows.map(row);

exports.create = async (organizationId, input) => {
  const name = nameSchema.safeParse(input.name);
  if (!name.success) throw fail(400, name.error.issues[0].message);
  const media = await messageService.prepareVideo(input);
  const uploaded = await messageService.uploadMedia(media);
  const created = (await db.query(
    `INSERT INTO saved_videos (organization_id, name, filename, bytes, file, media_id, media_uploaded_at, position)
     VALUES ($1,$2,$3,$4,$5,$6,now(), COALESCE((SELECT MAX(position)+1 FROM saved_videos WHERE organization_id=$1),0))
     RETURNING ${COLUMNS}`,
    [organizationId, name.data, input.filename || 'video.mp4', media.buffer.length, media.buffer, uploaded.mediaId],
  )).rows[0];
  return row(created);
};

exports.update = async (organizationId, id, input) => {
  const parsed = updateSchema.safeParse(input || {});
  if (!parsed.success) throw fail(400, parsed.error.issues[0].message);
  const updated = (await db.query(
    `UPDATE saved_videos SET name=COALESCE($3,name), chat_shortcut=COALESCE($4,chat_shortcut), updated_at=now()
     WHERE id=$1 AND organization_id=$2 RETURNING ${COLUMNS}`,
    [id, organizationId, parsed.data.name ?? null, parsed.data.chatShortcut ?? null],
  )).rows[0];
  if (!updated) throw fail(404, 'Video no encontrado');
  return row(updated);
};

exports.remove = async (organizationId, id) => {
  const removed = await db.query('DELETE FROM saved_videos WHERE id=$1 AND organization_id=$2 RETURNING id', [id, organizationId]);
  if (!removed.rows[0]) throw fail(404, 'Video no encontrado');
};

/** MP4 guardado (para verlo en MerlynSeller sin pedirlo a Meta). */
exports.file = async (organizationId, id) => {
  const video = (await db.query('SELECT file FROM saved_videos WHERE id=$1 AND organization_id=$2', [id, organizationId])).rows[0];
  if (!video) throw fail(404, 'Video no encontrado');
  return video.file;
};

/** Archivo de Meta vigente: si venció (o está por vencer), se vuelve a subir el MP4 guardado. */
exports.freshMediaId = async (organizationId, id) => {
  const video = (await db.query(
    `SELECT id, media_id, filename, (media_id IS NULL OR media_uploaded_at IS NULL OR media_uploaded_at <= now() - ($3 || ' days')::interval) AS stale
     FROM saved_videos WHERE id=$1 AND organization_id=$2`, [id, organizationId, String(REUSE_DAYS)],
  )).rows[0];
  if (!video) throw fail(404, 'Video no encontrado');
  if (!video.stale) return video.media_id;
  const file = await exports.file(organizationId, id);
  const uploaded = await messageService.uploadMedia({ buffer: file, contentType: 'video/mp4', filename: video.filename || 'video.mp4' });
  await db.query('UPDATE saved_videos SET media_id=$3, media_uploaded_at=now() WHERE id=$1 AND organization_id=$2', [id, organizationId, uploaded.mediaId]);
  console.log(JSON.stringify({ level: 'info', message: 'Saved video re-uploaded to Meta', videoId: id }));
  return uploaded.mediaId;
};

exports.queueSaved = async (organizationId, conversationId, input = {}) => {
  const parsed = z.object({ videoId: z.string().uuid(), caption }).safeParse(input);
  if (!parsed.success) throw fail(400, 'Elige un video guardado.');
  const mediaId = await exports.freshMediaId(organizationId, parsed.data.videoId);
  return require('./conversation.service').queueExistingMedia(organizationId, conversationId, 'video', mediaId, parsed.data.caption);
};
