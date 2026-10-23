const { z } = require('zod');
const db = require('../lib/db');
const reminders = require('./reminder.service');

// Chat interno «Recordatorios» del inbox: avisos de recordatorios y notas del equipo.
// No está conectado a WhatsApp.
const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };
const columns = `m.id, m.kind, m.body, m.payload, m.created_at AS "createdAt", m.read_at AS "readAt",
  m.reminder_id AS "reminderId", r.status AS "reminderStatus", u.display_name AS "authorName", u.email AS "authorEmail"`;

exports.messages = async (organizationId, query = {}) => {
  // Por si el worker no está corriendo, al abrir el chat también se publican los pendientes.
  await reminders.deliverDue(organizationId).catch(() => undefined);
  const values = [organizationId];
  let before = '';
  if (query.before) {
    if (Number.isNaN(Date.parse(query.before))) fail(400, 'Fecha inválida');
    values.push(new Date(query.before));
    before = `AND m.created_at < $${values.length}`;
  }
  const rows = (await db.query(
    `SELECT ${columns} FROM internal_messages m
     LEFT JOIN reminders r ON r.id = m.reminder_id
     LEFT JOIN users u ON u.id = m.author_id
     WHERE m.organization_id=$1 ${before}
     ORDER BY m.created_at DESC LIMIT 60`,
    values,
  )).rows;
  return { messages: rows.reverse(), hasMore: rows.length === 60 };
};

exports.unread = async (organizationId) => {
  await reminders.deliverDue(organizationId).catch(() => undefined);
  const result = await db.query('SELECT count(*)::int AS count FROM internal_messages WHERE organization_id=$1 AND read_at IS NULL', [organizationId]);
  return { unread: result.rows[0]?.count || 0 };
};

exports.markRead = async (organizationId) => {
  await db.query('UPDATE internal_messages SET read_at=now() WHERE organization_id=$1 AND read_at IS NULL', [organizationId]);
  return { unread: 0 };
};

const note = z.object({ body: z.string().trim().min(1, 'Escribe la nota').max(4000, 'La nota admite máximo 4000 caracteres') });
exports.addNote = async (organizationId, userId, input) => {
  const parsed = note.safeParse(input || {});
  if (!parsed.success) fail(400, parsed.error.issues[0].message);
  const result = await db.query(
    `WITH inserted AS (
       INSERT INTO internal_messages (organization_id, kind, body, author_id, read_at) VALUES ($1,'note',$2,$3,now()) RETURNING *
     )
     SELECT ${columns} FROM inserted m LEFT JOIN reminders r ON r.id = m.reminder_id LEFT JOIN users u ON u.id = m.author_id`,
    [organizationId, parsed.data.body, userId || null],
  );
  return result.rows[0];
};
