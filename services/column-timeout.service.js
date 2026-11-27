const { z } = require('zod');
const db = require('../lib/db');
const realtime = require('../lib/realtime');

// ⏳ por columna: si el cliente no responde a nuestro último mensaje en la espera configurada, el lead
// pasa solo a otra columna (sin enviar mensaje). Cualquier respuesta del cliente reinicia la cuenta,
// y la espera nunca empieza antes de que el lead llegue a la columna ni de que se active la regla.
const fail = (status, message) => Object.assign(new Error(message), { status });
const log = (level, message, fields = {}) => console.log(JSON.stringify({ level, message, ...fields }));

const schema = z.object({
  isActive: z.boolean().default(true),
  // De 30 minutos a 90 días.
  waitMinutes: z.coerce.number().int().min(30, 'La espera mínima es de 30 minutos.').max(129600, 'La espera máxima es de 90 días.'),
  targetColumnId: z.string({ error: 'Elige la columna a la que se moverá.' }).uuid('Elige la columna a la que se moverá.'),
}).strict();

const COLUMNS = 'id, column_id AS "columnId", target_column_id AS "targetColumnId", wait_minutes AS "waitMinutes", is_active AS "isActive", activated_at AS "activatedAt", updated_at AS "updatedAt"';

exports.list = async (organizationId) =>
  (await db.query(`SELECT ${COLUMNS} FROM column_timeouts WHERE organization_id=$1`, [organizationId])).rows;

exports.save = async (organizationId, columnId, input) => {
  const parsed = schema.safeParse(input || {});
  if (!parsed.success) throw fail(400, parsed.error.issues[0].message);
  const value = parsed.data;
  if (value.targetColumnId === columnId) throw fail(400, 'Elige una columna distinta a esta.');
  const found = await db.query('SELECT id FROM lead_columns WHERE organization_id=$1 AND id = ANY($2::uuid[])', [organizationId, [columnId, value.targetColumnId]]);
  if (found.rows.length !== 2) throw fail(404, 'La columna ya no existe.');
  // Al activarla (o reactivarla) la cuenta empieza desde ahora para los chats que ya estaban ahí.
  return (await db.query(
    `INSERT INTO column_timeouts (organization_id, column_id, target_column_id, wait_minutes, is_active, activated_at)
     VALUES ($1,$2,$3,$4,$5,now())
     ON CONFLICT (column_id) DO UPDATE SET target_column_id=EXCLUDED.target_column_id, wait_minutes=EXCLUDED.wait_minutes,
       is_active=EXCLUDED.is_active, activated_at=CASE WHEN column_timeouts.is_active THEN column_timeouts.activated_at ELSE now() END, updated_at=now()
     RETURNING ${COLUMNS}`,
    [organizationId, columnId, value.targetColumnId, value.waitMinutes, value.isActive],
  )).rows[0];
};

exports.remove = async (organizationId, columnId) => {
  await db.query('DELETE FROM column_timeouts WHERE organization_id=$1 AND column_id=$2', [organizationId, columnId]);
};

/** Chats a los que ya les tocó moverse: el último mensaje es nuestro (no fallido) y venció la espera. */
const due = () => db.query(`
  SELECT c.id AS conversation_id, c.organization_id, t.column_id, t.target_column_id
  FROM column_timeouts t
  JOIN conversations c ON c.organization_id = t.organization_id AND c.lead_column_id = t.column_id
  JOIN LATERAL (
    SELECT direction, status, created_at FROM messages m
    WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
    ORDER BY m.created_at DESC, COALESCE(m.outbound_sequence, 0) DESC LIMIT 1
  ) latest ON true
  WHERE t.is_active AND latest.direction = 'outbound' AND latest.status NOT IN ('failed', 'pending', 'processing')
    AND GREATEST(latest.created_at, c.lead_column_entered_at, t.activated_at) + make_interval(mins => t.wait_minutes) <= now()
  ORDER BY latest.created_at
  LIMIT 500`);

let running = false;
exports.run = async () => {
  if (running) return { moved: 0 };
  running = true;
  let moved = 0;
  try {
    for (const item of (await due()).rows) {
      // Solo si sigue en la misma columna (alguien pudo moverlo mientras tanto).
      const result = await db.query(
        'UPDATE conversations SET lead_column_id=$3, updated_at=now() WHERE id=$1 AND organization_id=$2 AND lead_column_id=$4 RETURNING id',
        [item.conversation_id, item.organization_id, item.target_column_id, item.column_id],
      );
      if (!result.rows[0]) continue;
      moved += 1;
      await realtime.publish(item.organization_id, 'lead.moved', item.conversation_id);
      log('info', 'Lead moved by column timeout', { conversationId: item.conversation_id, from: item.column_id, to: item.target_column_id });
    }
  } finally { running = false; }
  return { moved };
};
