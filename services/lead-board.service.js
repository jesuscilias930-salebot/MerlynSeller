const { z } = require('zod');
const db = require('../lib/db');
const realtime = require('../lib/realtime');
const leads = require('./lead.service');

// Multi dashboard: cada dashboard es un producto + zona con sus propias columnas.
// Un chat está en un solo dashboard: el de la columna donde está.
const optionalText = (max) => z.string().transform((value) => value.trim()).refine((value) => value.length <= max, `Máximo ${max} caracteres`).nullable().optional()
  .transform((value) => value || null);
const boardSchema = z.object({
  name: z.string().transform((value) => value.trim()).refine((value) => value.length >= 1 && value.length <= 60, 'Escribe un nombre de hasta 60 caracteres'),
  product: optionalText(80),
  zone: optionalText(80),
});
const orderSchema = z.object({ boardIds: z.array(z.string().uuid()).min(1).max(100) });
const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };
const parse = (schema, input) => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) fail(400, parsed.error.issues[0].message);
  return parsed.data;
};
const uuid = (value) => z.string().uuid().safeParse(value).success;
const duplicate = (error) => { if (error.code === '23505') fail(409, 'Ya existe un dashboard con ese nombre'); throw error; };

/** Dashboards con sus columnas y contadores ligeros (sin cargar los chats). */
exports.list = async (organizationId, userId) => {
  const [boards, columns] = await Promise.all([
    db.query(
      'SELECT id, name, product, zone, position, is_default AS "isDefault" FROM lead_boards WHERE organization_id = $1 ORDER BY position, created_at',
      [organizationId],
    ),
    db.query(`
      WITH conv AS (
        SELECT c.id, c.lead_column_id, c.scenario_enabled,
          EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'inbound'
            AND m.created_at > GREATEST(COALESCE((SELECT last_read_at FROM conversation_read_states rs WHERE rs.conversation_id = c.id AND rs.user_id = $2), '-infinity'::timestamptz),
            -- Ya respondido (por una persona o por el CRM): lo anterior a la respuesta no queda pendiente.
            COALESCE((SELECT max(answer.created_at) FROM messages answer WHERE answer.conversation_id = c.id AND answer.direction = 'outbound' AND answer.status <> 'failed' AND answer.deleted_at IS NULL), '-infinity'::timestamptz))) AS unread
        FROM conversations c WHERE c.organization_id = $1
      )
      SELECT column_row.id, column_row.name, column_row.position, column_row.board_id AS "boardId",
        count(conv.id)::int AS "leadCount",
        count(conv.id) FILTER (WHERE conv.scenario_enabled = false)::int AS "scenariosPaused",
        count(conv.id) FILTER (WHERE conv.unread)::int AS "unreadLeads"
      FROM lead_columns column_row LEFT JOIN conv ON conv.lead_column_id = column_row.id
      WHERE column_row.organization_id = $1
      GROUP BY column_row.id
      ORDER BY column_row.position, column_row.created_at
    `, [organizationId, userId]),
  ]);
  return boards.rows.map((board) => {
    const own = columns.rows.filter((column) => column.boardId === board.id);
    return {
      ...board,
      leadCount: own.reduce((total, column) => total + column.leadCount, 0),
      unreadLeads: own.reduce((total, column) => total + column.unreadLeads, 0),
      columns: own,
    };
  });
};

// Plantilla «Campaña»: la escalera de recontacto. Los ⏳ quedan configurados en pausa (3, 4 y 7 días)
// para activarlos cuando la campaña arranque.
const CAMPAIGN_TEMPLATE = {
  columns: ['Cotización', 'Remarketing 1', 'Remarketing 2', 'Remarketing 3', 'Dudas', 'Cierre', 'Pedido', 'Perdido'],
  timeouts: [['Remarketing 1', 'Remarketing 2', 3 * 1440], ['Remarketing 2', 'Remarketing 3', 4 * 1440], ['Remarketing 3', 'Perdido', 7 * 1440]],
};
const sourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('empty') }),
  z.object({ type: z.literal('clone'), boardId: z.string({ error: 'Elige el dashboard a copiar' }).uuid('Elige el dashboard a copiar') }),
  z.object({ type: z.literal('template'), template: z.literal('campaign') }),
]).optional().default({ type: 'empty' });

/** Copia las columnas de otro dashboard con sus ⏳ y ⏱ (en pausa; los destinos dentro del dashboard se reapuntan). */
const cloneColumns = async (client, organizationId, sourceBoardId, boardId) => {
  const source = await client.query('SELECT id, name, position FROM lead_columns WHERE organization_id=$1 AND board_id=$2 ORDER BY position, created_at', [organizationId, sourceBoardId]);
  if (!source.rows.length) fail(404, 'El dashboard a copiar ya no existe');
  const map = new Map();
  for (const [index, column] of source.rows.entries()) {
    const created = await client.query('INSERT INTO lead_columns (organization_id, board_id, name, position) VALUES ($1,$2,$3,$4) RETURNING id', [organizationId, boardId, column.name, index]);
    map.set(column.id, created.rows[0].id);
  }
  const remap = (id) => (id && map.get(id)) || id || null;
  const sourceIds = [...map.keys()];
  const timeouts = await client.query('SELECT column_id, target_column_id, wait_minutes FROM column_timeouts WHERE organization_id=$1 AND column_id = ANY($2::uuid[])', [organizationId, sourceIds]);
  for (const row of timeouts.rows) {
    await client.query('INSERT INTO column_timeouts (organization_id, column_id, target_column_id, wait_minutes, is_active) VALUES ($1,$2,$3,$4,false)', [organizationId, map.get(row.column_id), remap(row.target_column_id), row.wait_minutes]);
  }
  const followUps = await client.query('SELECT column_id, steps, final_column_id FROM follow_up_sequences WHERE organization_id=$1 AND column_id = ANY($2::uuid[])', [organizationId, sourceIds]);
  for (const row of followUps.rows) {
    await client.query('INSERT INTO follow_up_sequences (organization_id, column_id, is_active, steps, final_column_id) VALUES ($1,$2,false,$3::jsonb,$4)', [organizationId, map.get(row.column_id), JSON.stringify(row.steps || []), remap(row.final_column_id)]);
  }
  return { columns: source.rows.length, timeouts: timeouts.rows.length, followUps: followUps.rows.length };
};

const templateColumns = async (client, organizationId, boardId) => {
  const ids = new Map();
  for (const [index, name] of CAMPAIGN_TEMPLATE.columns.entries()) {
    const created = await client.query('INSERT INTO lead_columns (organization_id, board_id, name, position) VALUES ($1,$2,$3,$4) RETURNING id', [organizationId, boardId, name, index]);
    ids.set(name, created.rows[0].id);
  }
  for (const [from, to, minutes] of CAMPAIGN_TEMPLATE.timeouts) {
    await client.query('INSERT INTO column_timeouts (organization_id, column_id, target_column_id, wait_minutes, is_active) VALUES ($1,$2,$3,$4,false)', [organizationId, ids.get(from), ids.get(to), minutes]);
  }
  return { columns: CAMPAIGN_TEMPLATE.columns.length, timeouts: CAMPAIGN_TEMPLATE.timeouts.length, followUps: 0 };
};

/**
 * Crea un dashboard bajo demanda: vacío («Primer contacto»), copiando la estructura de otro (columnas,
 * ⏳ y ⏱ en pausa, sin leads) o desde la plantilla de campaña.
 */
exports.create = async (organizationId, input) => {
  const data = parse(boardSchema, input);
  const source = parse(sourceSchema, input?.source);
  const board = await db.transaction(async (client) => {
    const created = await client.query(
      `INSERT INTO lead_boards (organization_id, name, product, zone, position)
       VALUES ($1, $2, $3, $4, COALESCE((SELECT MAX(position) + 1 FROM lead_boards WHERE organization_id = $1), 0))
       RETURNING id, name, product, zone, position, is_default AS "isDefault"`,
      [organizationId, data.name, data.product, data.zone],
    ).catch(duplicate);
    const boardId = created.rows[0].id;
    let copied = { columns: 1, timeouts: 0, followUps: 0 };
    if (source.type === 'clone') copied = await cloneColumns(client, organizationId, source.boardId, boardId);
    else if (source.type === 'template') copied = await templateColumns(client, organizationId, boardId);
    else await client.query("INSERT INTO lead_columns (organization_id, board_id, name, position) VALUES ($1, $2, 'Primer contacto', 0)", [organizationId, boardId]);
    return { ...created.rows[0], copied };
  });
  await realtime.publish(organizationId, 'lead.board_created');
  return board;
};

/**
 * Mueve una columna (con sus leads, ⏳ y ⏱) a otro dashboard; queda al final. El dashboard de origen
 * debe conservar al menos una columna y el destino no puede tener otra con el mismo nombre.
 */
exports.moveColumn = async (organizationId, columnId, input) => {
  const targetBoardId = input?.boardId;
  if (!uuid(columnId)) fail(404, 'Columna no encontrada');
  if (!uuid(targetBoardId)) fail(400, 'Elige el dashboard de destino');
  const moved = await db.transaction(async (client) => {
    const column = (await client.query('SELECT id, name, board_id FROM lead_columns WHERE id=$1 AND organization_id=$2 FOR UPDATE', [columnId, organizationId])).rows[0];
    if (!column) fail(404, 'Columna no encontrada');
    if (column.board_id === targetBoardId) fail(400, 'La columna ya está en ese dashboard');
    const target = (await client.query('SELECT id, name FROM lead_boards WHERE id=$1 AND organization_id=$2', [targetBoardId, organizationId])).rows[0];
    if (!target) fail(404, 'Dashboard no encontrado');
    const remaining = await client.query('SELECT count(*)::int AS total FROM lead_columns WHERE board_id=$1 AND id<>$2', [column.board_id, columnId]);
    if (!remaining.rows[0].total) fail(400, 'Cada dashboard necesita al menos una columna: agrega otra antes de mover esta');
    const result = await client.query(
      `UPDATE lead_columns SET board_id=$3, position=COALESCE((SELECT MAX(position)+1 FROM lead_columns WHERE board_id=$3),0)
       WHERE id=$1 AND organization_id=$2 RETURNING id, name, board_id AS "boardId", position`,
      [columnId, organizationId, targetBoardId],
    ).catch((error) => { if (error.code === '23505') fail(409, `«${target.name}» ya tiene una columna llamada «${column.name}». Renómbrala antes de moverla.`); throw error; });
    return { ...result.rows[0], boardName: target.name };
  });
  await realtime.publish(organizationId, 'lead.board_created');
  return moved;
};

exports.update = async (organizationId, id, input) => {
  if (!uuid(id)) fail(404, 'Dashboard no encontrado');
  const data = parse(boardSchema, input);
  const result = await db.query(
    `UPDATE lead_boards SET name = $3, product = $4, zone = $5, updated_at = now() WHERE id = $1 AND organization_id = $2
     RETURNING id, name, product, zone, position, is_default AS "isDefault"`,
    [id, organizationId, data.name, data.product, data.zone],
  ).catch(duplicate);
  if (!result.rows[0]) fail(404, 'Dashboard no encontrado');
  await realtime.publish(organizationId, 'lead.board_updated');
  return result.rows[0];
};

/** Borra un dashboard: sus leads, reglas y pasos de escenarios pasan al principal
 *  (a la columna con el mismo nombre o, si no existe, a la primera). */
exports.remove = async (organizationId, id) => {
  if (!uuid(id)) fail(404, 'Dashboard no encontrado');
  const result = await db.transaction(async (client) => {
    const board = await client.query('SELECT id, is_default FROM lead_boards WHERE id = $1 AND organization_id = $2 FOR UPDATE', [id, organizationId]);
    if (!board.rows[0]) fail(404, 'Dashboard no encontrado');
    if (board.rows[0].is_default) fail(409, 'El dashboard principal no se puede eliminar');
    const columns = await client.query(
      `SELECT column_row.id, column_row.name, column_row.board_id = $2 AS own FROM lead_columns column_row JOIN lead_boards board ON board.id = column_row.board_id
       WHERE column_row.organization_id = $1 AND (column_row.board_id = $2 OR board.is_default) ORDER BY column_row.position, column_row.created_at`,
      [organizationId, id],
    );
    const targets = columns.rows.filter((column) => !column.own);
    if (!targets.length) fail(409, 'El dashboard principal no tiene columnas a donde pasar los leads');
    const map = new Map(columns.rows.filter((column) => column.own).map((column) => [
      column.id,
      (targets.find((target) => leads.normalizedColumnName(target.name) === leads.normalizedColumnName(column.name)) || targets[0]).id,
    ]));
    const movedLeads = map.size ? await leads.remapColumns(client, organizationId, map) : 0;
    await client.query('DELETE FROM lead_boards WHERE id = $1 AND organization_id = $2', [id, organizationId]);
    return { deletedId: id, movedLeads };
  });
  await realtime.publish(organizationId, 'lead.board_removed');
  return result;
};

exports.reorder = async (organizationId, input) => {
  const data = parse(orderSchema, input);
  await db.query(
    `UPDATE lead_boards board SET position = ordered.ord - 1, updated_at = now()
     FROM unnest($2::uuid[]) WITH ORDINALITY AS ordered(id, ord) WHERE board.id = ordered.id AND board.organization_id = $1`,
    [organizationId, data.boardIds],
  );
  await realtime.publish(organizationId, 'lead.boards_reordered');
  return exports.list(organizationId, null);
};
