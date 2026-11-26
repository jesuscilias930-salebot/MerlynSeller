const { z } = require('zod');
const db = require('../lib/db');

// Seguimientos automáticos por columna: si el cliente deja de responder (el último mensaje es nuestro),
// después de la espera de cada paso se le escribe. Se detiene en cuanto el cliente contesta y vuelve a
// empezar si después de esa respuesta otra vez deja de escribir.
const MAX_STEPS = 3;
const HOUR = 60 * 60 * 1000;
const fail = (status, message) => Object.assign(new Error(message), { status });
const log = (level, message, fields = {}) => console.log(JSON.stringify({ level, message, ...fields }));

const stepSchema = z.object({
  // De 30 minutos a 30 días.
  waitMinutes: z.coerce.number().int().min(30, 'La espera mínima es de 30 minutos.').max(43200, 'La espera máxima es de 30 días.'),
  text: z.string().trim().max(4096).optional().transform((value) => value || undefined),
  imageIds: z.array(z.string().uuid()).max(10, 'Hasta 10 fotos por paso.').optional().default([]),
  videoId: z.string().uuid().nullable().optional().transform((value) => value || undefined),
  // Para cuando ya pasaron las 24 h: WhatsApp solo permite plantillas aprobadas.
  templateId: z.string().uuid().nullable().optional().transform((value) => value || undefined),
}).superRefine((step, ctx) => {
  if (!step.text && !step.imageIds.length && !step.videoId && !step.templateId) ctx.addIssue({ code: 'custom', message: 'Cada paso necesita un mensaje, fotos, un video o una plantilla.' });
});
const sequenceSchema = z.object({
  isActive: z.boolean().default(false),
  steps: z.array(stepSchema).min(1, 'Agrega al menos un paso.').max(MAX_STEPS, `Hasta ${MAX_STEPS} pasos.`),
  finalColumnId: z.string().uuid().nullable().optional().transform((value) => value || null),
}).strict();

const parse = (input) => {
  const result = sequenceSchema.safeParse(input || {});
  if (!result.success) {
    const issue = result.error.issues[0];
    const stepIndex = issue.path[0] === 'steps' && typeof issue.path[1] === 'number' ? issue.path[1] : null;
    throw fail(400, `${stepIndex !== null ? `Paso ${stepIndex + 1}: ` : ''}${issue.message}`);
  }
  return result.data;
};

const row = (value) => value && ({
  id: value.id, columnId: value.column_id, isActive: value.is_active, activatedAt: value.activated_at,
  steps: value.steps || [], finalColumnId: value.final_column_id, updatedAt: value.updated_at,
  ...(value.active_count !== undefined ? { activeCount: Number(value.active_count) } : {}),
});

exports.list = async (organizationId) => (await db.query(`
  SELECT s.*, (SELECT count(*) FROM conversation_follow_ups f WHERE f.sequence_id = s.id AND f.status = 'active') AS active_count
  FROM follow_up_sequences s WHERE s.organization_id = $1 ORDER BY s.created_at`, [organizationId])).rows.map(row);

/** Una plantilla automática no puede pedir valores escritos a mano al enviar. */
const ensureTemplate = async (organizationId, templateId) => {
  const template = (await db.query("SELECT name, status, variable_mappings FROM whatsapp_templates WHERE id=$1 AND organization_id=$2", [templateId, organizationId])).rows[0];
  if (!template) throw fail(400, 'La plantilla elegida ya no existe.');
  if (template.status !== 'APPROVED') throw fail(400, `La plantilla «${template.name}» aún no está aprobada por Meta.`);
  if ((template.variable_mappings || []).some((mapping) => mapping.source === 'manual')) throw fail(400, `La plantilla «${template.name}» pide valores escritos a mano; para seguimientos usa una con nombre, teléfono o texto fijo.`);
};

exports.save = async (organizationId, columnId, input) => {
  const value = parse(input);
  const columns = await db.query('SELECT id FROM lead_columns WHERE organization_id=$1 AND id = ANY($2::uuid[])', [organizationId, [columnId, value.finalColumnId].filter(Boolean)]);
  if (!columns.rows.some((item) => item.id === columnId)) throw fail(404, 'Columna no encontrada.');
  if (value.finalColumnId && !columns.rows.some((item) => item.id === value.finalColumnId)) throw fail(400, 'La columna final ya no existe.');
  if (value.finalColumnId === columnId) throw fail(400, 'La columna final debe ser distinta.');
  const imageIds = [...new Set(value.steps.flatMap((step) => step.imageIds))];
  if (imageIds.length) {
    const found = await db.query('SELECT image.id FROM entrepreneur_package_images image JOIN entrepreneur_packages p ON p.id=image.package_id WHERE p.organization_id=$1 AND image.id = ANY($2::uuid[])', [organizationId, imageIds]);
    if (found.rows.length !== imageIds.length) throw fail(400, 'Una de las fotos ya no existe en Imágenes guardadas.');
  }
  const videoIds = [...new Set(value.steps.map((step) => step.videoId).filter(Boolean))];
  if (videoIds.length) {
    const found = await db.query('SELECT id FROM saved_videos WHERE organization_id=$1 AND id = ANY($2::uuid[])', [organizationId, videoIds]);
    if (found.rows.length !== videoIds.length) throw fail(400, 'Uno de los videos ya no existe en Videos guardados.');
  }
  for (const templateId of new Set(value.steps.map((step) => step.templateId).filter(Boolean))) await ensureTemplate(organizationId, templateId);
  const saved = (await db.query(`
    INSERT INTO follow_up_sequences (organization_id, column_id, is_active, activated_at, steps, final_column_id)
    VALUES ($1,$2,$3, CASE WHEN $3 THEN now() END, $4::jsonb, $5)
    ON CONFLICT (column_id) DO UPDATE SET
      is_active = EXCLUDED.is_active,
      -- Al activarlo (no al editarlo) empieza a contar: solo chats con actividad desde ese momento.
      activated_at = CASE WHEN EXCLUDED.is_active AND NOT follow_up_sequences.is_active THEN now() WHEN EXCLUDED.is_active THEN follow_up_sequences.activated_at ELSE NULL END,
      steps = EXCLUDED.steps, final_column_id = EXCLUDED.final_column_id, updated_at = now()
    WHERE follow_up_sequences.organization_id = $1
    RETURNING *`, [organizationId, columnId, value.isActive, JSON.stringify(value.steps), value.finalColumnId])).rows[0];
  if (!saved) throw fail(404, 'Columna no encontrada.');
  return row(saved);
};

exports.remove = async (organizationId, columnId) => {
  await db.query('DELETE FROM follow_up_sequences WHERE organization_id=$1 AND column_id=$2', [organizationId, columnId]);
};

// ——— Decisión de cada chat (pura, para probarla) ———
const localHour = (date, timezone) => Number(new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(date));
exports.QUIET = { from: 21, to: 9 };
/**
 * ¿Qué hacer ahora con este chat?
 * - wait: aún no toca (espera, horario nocturno o hay un mensaje nuestro en cola).
 * - send: dentro de la ventana para mensajes libres. En WhatsApp siempre son 24 h desde el último
 *   mensaje del cliente: la ventana de 72 h de los anuncios solo hace gratis los mensajes, pero
 *   después de 24 h únicamente acepta plantillas.
 * - template: fuera de la ventana, con plantilla aprobada.
 * - stop: fuera de la ventana y sin plantilla (o canal sin plantillas).
 */
exports.decide = ({ step, lastOutAt, lastInAt, fromAd = false, channel = 'whatsapp', now = new Date(), timezone = 'America/Mexico_City', outboundQueued = false }) => {
  if (!step) return { action: 'complete' };
  if (outboundQueued) return { action: 'wait', reason: 'queued' };
  const dueAt = new Date(new Date(lastOutAt).getTime() + step.waitMinutes * 60000);
  if (now < dueAt) return { action: 'wait', reason: 'not_due', dueAt };
  const hour = localHour(now, timezone);
  if (hour >= exports.QUIET.from || hour < exports.QUIET.to) return { action: 'wait', reason: 'quiet_hours', dueAt };
  const sinceInbound = lastInAt ? now - new Date(lastInAt) : Infinity;
  const freeWindow = channel === 'whatsapp' ? 24 * HOUR : (fromAd ? 7 * 24 : 24) * HOUR;
  const hasContent = Boolean(step.text || step.imageIds?.length || step.videoId);
  if (sinceInbound < freeWindow && hasContent) return { action: 'send' };
  if (channel === 'whatsapp' && step.templateId) return { action: 'template' };
  return { action: 'stop', reason: channel === 'whatsapp' ? 'Pasaron más de 24 h y el paso no tiene plantilla aprobada.' : 'Messenger e Instagram solo permiten escribir dentro de las 24 h.' };
};

const sendStep = async (organizationId, conversationId, step, action) => {
  const conversations = require('./conversation.service');
  if (action === 'template') return conversations.queueTemplate(organizationId, conversationId, { templateId: step.templateId });
  const caption = step.text && step.text.length <= 1024 ? step.text : undefined;
  if (step.text && !caption) await conversations.queueText(organizationId, conversationId, { body: step.text });
  if (!step.imageIds?.length && !step.videoId) {
    if (caption) await conversations.queueText(organizationId, conversationId, { body: caption });
    return;
  }
  if (step.imageIds?.length) await conversations.queueEntrepreneurPackages(organizationId, conversationId, { imageIds: step.imageIds, ...(caption ? { caption } : {}) });
  if (step.videoId) await require('./video-reuse.service').queueSaved(organizationId, conversationId, { videoId: step.videoId, ...(caption && !step.imageIds?.length ? { caption } : {}) });
};

/** Chats de las columnas con seguimiento activo cuyo último mensaje es nuestro. */
const candidates = () => db.query(`
  SELECT c.id AS conversation_id, c.organization_id, s.id AS sequence_id, s.steps, s.final_column_id,
    ct.channel, latest.direction AS latest_direction, latest.created_at AS last_out_at,
    inbound.created_at AS last_in_at, (inbound.referral IS NOT NULL) AS from_ad,
    EXISTS (SELECT 1 FROM messages q WHERE q.conversation_id = c.id AND q.direction = 'outbound' AND q.status IN ('pending', 'processing') AND q.deleted_at IS NULL) AS outbound_queued,
    f.sequence_id AS state_sequence_id, f.cycle_inbound_at, f.step_index, f.status AS state_status
  FROM follow_up_sequences s
  JOIN conversations c ON c.lead_column_id = s.column_id AND c.organization_id = s.organization_id
  JOIN contacts ct ON ct.id = c.contact_id
  JOIN LATERAL (SELECT direction, created_at FROM messages WHERE conversation_id = c.id AND deleted_at IS NULL ORDER BY created_at DESC, COALESCE(outbound_sequence, 0) DESC LIMIT 1) latest ON true
  LEFT JOIN LATERAL (SELECT created_at, referral FROM messages WHERE conversation_id = c.id AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1) inbound ON true
  LEFT JOIN conversation_follow_ups f ON f.conversation_id = c.id
  WHERE s.is_active AND c.status = 'open' AND c.auto_reply_enabled
    AND latest.direction = 'outbound' AND latest.created_at >= s.activated_at
  LIMIT 500`);

let running = false;
/** Lo llama el worker cada minuto. */
exports.run = async (now = new Date()) => {
  if (running) return { sent: 0 };
  running = true;
  let sent = 0;
  try {
    const timezones = new Map();
    const timezoneOf = async (organizationId) => {
      if (!timezones.has(organizationId)) timezones.set(organizationId, (await require('./business-hours.service').get(organizationId)).timezone || 'America/Mexico_City');
      return timezones.get(organizationId);
    };
    for (const item of (await candidates()).rows) {
      try {
        const cycle = item.last_in_at ? new Date(item.last_in_at).toISOString() : null;
        const sameCycle = item.state_sequence_id === item.sequence_id && (item.cycle_inbound_at ? new Date(item.cycle_inbound_at).toISOString() : null) === cycle;
        // Nuevo ciclo: otra columna, o el cliente escribió desde el último seguimiento.
        if (!sameCycle) {
          await db.query(`INSERT INTO conversation_follow_ups (conversation_id, organization_id, sequence_id, cycle_inbound_at, step_index, status, stopped_reason, last_step_at, updated_at)
            VALUES ($1,$2,$3,$4,0,'active',NULL,NULL,now())
            ON CONFLICT (conversation_id) DO UPDATE SET sequence_id=EXCLUDED.sequence_id, cycle_inbound_at=EXCLUDED.cycle_inbound_at, step_index=0, status='active', stopped_reason=NULL, last_step_at=NULL, updated_at=now()`,
          [item.conversation_id, item.organization_id, item.sequence_id, cycle]);
        } else if (item.state_status !== 'active') continue;
        const stepIndex = sameCycle ? item.step_index : 0;
        const step = (item.steps || [])[stepIndex];
        const decision = exports.decide({ step, lastOutAt: item.last_out_at, lastInAt: item.last_in_at, fromAd: item.from_ad, channel: item.channel || 'whatsapp', now, timezone: await timezoneOf(item.organization_id), outboundQueued: item.outbound_queued });
        if (decision.action === 'wait') continue;
        if (decision.action === 'complete') { await db.query("UPDATE conversation_follow_ups SET status='completed', updated_at=now() WHERE conversation_id=$1", [item.conversation_id]); continue; }
        if (decision.action === 'stop') { await db.query("UPDATE conversation_follow_ups SET status='stopped', stopped_reason=$2, updated_at=now() WHERE conversation_id=$1 AND status='active'", [item.conversation_id, decision.reason]); continue; }
        // Se reserva el paso antes de enviar: nunca se manda dos veces aunque algo falle a la mitad.
        const claimed = await db.query("UPDATE conversation_follow_ups SET step_index=step_index+1, last_step_at=now(), updated_at=now() WHERE conversation_id=$1 AND step_index=$2 AND status='active' RETURNING step_index", [item.conversation_id, stepIndex]);
        if (!claimed.rows[0]) continue;
        try {
          await sendStep(item.organization_id, item.conversation_id, step, decision.action);
          sent += 1;
          log('info', 'Follow-up step sent', { conversationId: item.conversation_id, step: stepIndex + 1, mode: decision.action });
        } catch (error) {
          await db.query("UPDATE conversation_follow_ups SET status='stopped', stopped_reason=$2, updated_at=now() WHERE conversation_id=$1", [item.conversation_id, `No se pudo enviar el paso ${stepIndex + 1}: ${error.message}`.slice(0, 300)]);
          log('warn', 'Follow-up step failed', { conversationId: item.conversation_id, step: stepIndex + 1, error: error.message });
          continue;
        }
        if (claimed.rows[0].step_index >= (item.steps || []).length) {
          await db.query("UPDATE conversation_follow_ups SET status='completed', updated_at=now() WHERE conversation_id=$1", [item.conversation_id]);
          if (item.final_column_id) await require('./lead.service').autoMove(item.organization_id, item.conversation_id, item.final_column_id).catch(() => false);
        }
      } catch (error) {
        log('error', 'Follow-up evaluation failed', { conversationId: item.conversation_id, error: error.message });
      }
    }
  } finally { running = false; }
  return { sent };
};

/** Estado del seguimiento de un chat (para mostrarlo y detenerlo desde el Inbox). */
exports.status = async (organizationId, conversationId) => {
  const value = (await db.query(`
    SELECT s.id AS sequence_id, s.steps, s.is_active, col.name AS column_name, f.step_index, f.status, f.stopped_reason, f.sequence_id AS state_sequence_id,
      (SELECT created_at FROM messages WHERE conversation_id = c.id AND direction = 'outbound' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1) AS last_out_at,
      (SELECT direction FROM messages WHERE conversation_id = c.id AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1) AS latest_direction
    FROM conversations c
    JOIN lead_columns col ON col.id = c.lead_column_id
    LEFT JOIN follow_up_sequences s ON s.column_id = c.lead_column_id AND s.is_active
    LEFT JOIN conversation_follow_ups f ON f.conversation_id = c.id
    WHERE c.id = $1 AND c.organization_id = $2`, [conversationId, organizationId])).rows[0];
  if (!value?.sequence_id) return { enabled: false };
  const steps = value.steps || [];
  const current = value.state_sequence_id === value.sequence_id ? value : { step_index: 0, status: 'active' };
  const step = steps[current.step_index];
  const waiting = value.latest_direction === 'outbound' && current.status === 'active' && step;
  return {
    enabled: true, columnName: value.column_name, totalSteps: steps.length, stepIndex: current.step_index,
    status: current.status, stoppedReason: current.stopped_reason || null,
    nextAt: waiting && value.last_out_at ? new Date(new Date(value.last_out_at).getTime() + step.waitMinutes * 60000).toISOString() : null,
    waitingForCustomer: value.latest_direction === 'inbound',
  };
};

/** Detiene el seguimiento de este ciclo (vuelve a empezar si el cliente escribe y luego deja de responder). */
exports.stop = async (organizationId, conversationId) => {
  const value = (await db.query(`
    SELECT c.id, s.id AS sequence_id, (SELECT created_at FROM messages WHERE conversation_id = c.id AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1) AS last_in_at
    FROM conversations c JOIN follow_up_sequences s ON s.column_id = c.lead_column_id
    WHERE c.id = $1 AND c.organization_id = $2`, [conversationId, organizationId])).rows[0];
  if (!value) throw fail(404, 'Este chat no tiene seguimiento.');
  await db.query(`INSERT INTO conversation_follow_ups (conversation_id, organization_id, sequence_id, cycle_inbound_at, step_index, status, stopped_reason)
    VALUES ($1,$2,$3,$4,0,'stopped','Detenido a mano')
    ON CONFLICT (conversation_id) DO UPDATE SET sequence_id=EXCLUDED.sequence_id, cycle_inbound_at=EXCLUDED.cycle_inbound_at, status='stopped', stopped_reason='Detenido a mano', updated_at=now()`,
  [conversationId, organizationId, value.sequence_id, value.last_in_at]);
  return exports.status(organizationId, conversationId);
};
