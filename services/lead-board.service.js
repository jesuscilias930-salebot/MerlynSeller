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
            AND m.created_at > COALESCE((SELECT last_read_at FROM conversation_read_states rs WHERE rs.conversation_id = c.id AND rs.user_id = $2), '-infinity'::timestamptz)) AS unread
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

/** Crea un dashboard con una sola columna: «Primer contacto». */
exports.create = async (organizationId, input) => {
  const data = parse(boardSchema, input);
  const board = await db.transaction(async (client) => {
    const created = await client.query(
      `INSERT INTO lead_boards (organization_id, name, product, zone, position)
       VALUES ($1, $2, $3, $4, COALESCE((SELECT MAX(position) + 1 FROM lead_boards WHERE organization_id = $1), 0))
       RETURNING id, name, product, zone, position, is_default AS "isDefault"`,
      [organizationId, data.name, data.product, data.zone],
    ).catch(duplicate);
    await client.query("INSERT INTO lead_columns (organization_id, board_id, name, position) VALUES ($1, $2, 'Primer contacto', 0)", [organizationId, created.rows[0].id]);
    return created.rows[0];
  });
  await realtime.publish(organizationId, 'lead.board_created');
  return board;
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
