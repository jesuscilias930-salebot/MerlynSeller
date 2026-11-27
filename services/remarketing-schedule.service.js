const { z } = require('zod');
const db = require('../lib/db');
const realtime = require('../lib/realtime');

// Horario del remarketing automático (hora del negocio). Entre «pausar» y «reanudar»:
//  · los seguimientos ⏱ esperan;
//  · con deferCampaigns, los envíos 📣 quedan programados y salen solos al reanudar.
// Al reanudar se envía todo lo pendiente, salvo a quien escribió mientras tanto (ya está conversando).
const fail = (status, message) => Object.assign(new Error(message), { status });
const log = (level, message, fields = {}) => console.log(JSON.stringify({ level, message, ...fields }));
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

// Sin configurar: el horario que ya tenían los seguimientos (9 p. m. a 9 a. m.) y los 📣 salen al momento.
const DEFAULTS = { isActive: true, pauseAt: '21:00', resumeAt: '09:00', deferCampaigns: false, configured: false };

const schema = z.object({
  isActive: z.boolean().default(true),
  pauseAt: z.string().regex(TIME, 'Escribe la hora de pausa como HH:MM'),
  resumeAt: z.string().regex(TIME, 'Escribe la hora de reanudar como HH:MM'),
  deferCampaigns: z.boolean().default(true),
}).strict().refine((value) => value.pauseAt !== value.resumeAt, 'La hora de pausa y la de reanudar deben ser distintas.');

const toMinutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

exports.get = async (organizationId) => {
  const row = (await db.query(
    'SELECT is_active AS "isActive", pause_at AS "pauseAt", resume_at AS "resumeAt", defer_campaigns AS "deferCampaigns" FROM remarketing_schedules WHERE organization_id=$1',
    [organizationId],
  )).rows[0];
  return row ? { ...row, configured: true } : { ...DEFAULTS };
};

exports.save = async (organizationId, input) => {
  const parsed = schema.safeParse(input || {});
  if (!parsed.success) throw fail(400, parsed.error.issues[0].message);
  const value = parsed.data;
  await db.query(
    `INSERT INTO remarketing_schedules (organization_id, is_active, pause_at, resume_at, defer_campaigns) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (organization_id) DO UPDATE SET is_active=EXCLUDED.is_active, pause_at=EXCLUDED.pause_at, resume_at=EXCLUDED.resume_at, defer_campaigns=EXCLUDED.defer_campaigns, updated_at=now()`,
    [organizationId, value.isActive, value.pauseAt, value.resumeAt, value.deferCampaigns],
  );
  return { ...value, configured: true };
};

/** ¿Está en pausa a estos minutos del día (hora local)? Acepta horarios que cruzan la medianoche. */
exports.isQuietAt = (schedule, minutes) => {
  if (!schedule?.isActive) return false;
  const pause = toMinutes(schedule.pauseAt);
  const resume = toMinutes(schedule.resumeAt);
  if (pause === resume) return false;
  return pause > resume ? minutes >= pause || minutes < resume : minutes >= pause && minutes < resume;
};

/** Estado ahora: si está en pausa y cuándo reanuda (instante real). */
exports.status = (schedule, timezone, at = new Date()) => {
  const local = require('./business-hours.service').localParts(at, timezone || 'America/Mexico_City');
  if (!exports.isQuietAt(schedule, local.minutes)) return { quiet: false };
  const wait = (toMinutes(schedule.resumeAt) - local.minutes + 1440) % 1440;
  const resumeAt = new Date(at.getTime() + wait * 60000);
  resumeAt.setUTCSeconds(0, 0);
  return { quiet: true, resumeAt };
};

/** Para campañas 📣: si toca aplazar, la fecha a la que se programan; si no, null. */
exports.deferUntil = async (organizationId, at = new Date()) => {
  const schedule = await exports.get(organizationId);
  if (!schedule.deferCampaigns) return null;
  const { timezone } = await require('./business-hours.service').get(organizationId);
  const status = exports.status(schedule, timezone, at);
  return status.quiet ? status.resumeAt : null;
};

const JOB = (type) => (type === 'template' ? 'send-remarketing-template' : 'send-remarketing');

/** Cada minuto: libera los programados que ya tocan (o cancela si el cliente escribió después de programarlos). */
let running = false;
exports.release = async () => {
  if (running) return { released: 0, cancelled: 0 };
  running = true;
  try {
    const cancelled = await db.query(`
      UPDATE messages m SET status='failed', error_code='cancelled_customer_replied', scheduled_for=NULL, updated_at=now()
      WHERE m.status='scheduled' AND m.scheduled_for <= now() AND m.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM messages i WHERE i.conversation_id=m.conversation_id AND i.direction='inbound' AND i.created_at > m.created_at)
      RETURNING m.id, m.organization_id`);
    const released = await db.query(`
      UPDATE messages SET status='pending', scheduled_for=NULL, updated_at=now()
      WHERE status='scheduled' AND scheduled_for <= now() AND deleted_at IS NULL
      RETURNING id, type, organization_id`);
    const queue = require('../lib/queue').outboundQueue();
    for (const message of released.rows) await queue.add(JOB(message.type), { messageId: message.id }, { jobId: `${message.id}:released` });
    for (const organizationId of new Set([...released.rows, ...cancelled.rows].map((row) => row.organization_id))) {
      await realtime.publish(organizationId, 'remarketing.queued');
    }
    if (released.rowCount || cancelled.rowCount) log('info', 'Scheduled remarketing released', { released: released.rowCount, cancelled: cancelled.rowCount });
    return { released: released.rowCount, cancelled: cancelled.rowCount };
  } finally { running = false; }
};
