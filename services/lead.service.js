const { z } = require('zod');
const db = require('../lib/db');
const realtime = require('../lib/realtime');

const columnSchema = z.object({ name: z.string().trim().min(2).max(80), boardId: z.string().uuid().optional() });
const moveSchema = z.object({ columnId: z.string().uuid() });
const bulkMoveSchema = z.object({ targetColumnId: z.string().uuid() });
const reorderSchema = z.object({ columnIds: z.array(z.string().uuid()).min(1).max(100) });

const validate = (schema, value) => {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const error = new Error(parsed.error.issues[0].message);
  error.status = 400;
  throw error;
};

// Los chats nuevos entran a la primera columna del dashboard principal.
const initialColumn = (client, organizationId) => client.query(
  `SELECT column_row.id FROM lead_columns column_row JOIN lead_boards board ON board.id = column_row.board_id
   WHERE column_row.organization_id = $1
   ORDER BY board.is_default DESC, board.position ASC, column_row.position ASC, column_row.created_at ASC LIMIT 1`,
  [organizationId],
);
const isUuid = (value) => z.string().uuid().safeParse(value).success;
/** Dashboard pedido si es de la organización; si no, el principal. */
const resolveBoardId = async (client, organizationId, boardId) => {
  const result = await client.query(
    'SELECT id FROM lead_boards WHERE organization_id = $1 AND (id = $2 OR is_default) ORDER BY (id = $2) DESC, is_default DESC LIMIT 1',
    [organizationId, isUuid(boardId) ? boardId : null],
  );
  if (!result.rows[0]) { const error = new Error('Lead pipeline is not configured'); error.status = 500; throw error; }
  return result.rows[0].id;
};
exports.resolveBoardId = resolveBoardId;

const normalizedColumnName = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-zA-Z0-9]/g, '')
  .toLowerCase();

exports.initialColumnId = async (client, organizationId) => {
  const result = await initialColumn(client, organizationId);
  if (!result.rows[0]) {
    const error = new Error('Lead pipeline is not configured');
    error.status = 500;
    throw error;
  }
  return result.rows[0].id;
};

// Solo se cargan los leads del dashboard abierto (antes se cargaban todos los chats).
exports.board = async (organizationId, userId, boardId) => {
  const resolvedBoardId = await resolveBoardId(db, organizationId, boardId);
  const columns = await db.query(
    'SELECT id, name, position, board_id AS "boardId" FROM lead_columns WHERE organization_id = $1 AND board_id = $2 ORDER BY position ASC, created_at ASC',
    [organizationId, resolvedBoardId],
  );
  const leads = await db.query(`
    SELECT
      c.id,
      c.contact_id AS "contactId",
      c.lead_column_id,
      c.auto_reply_enabled AS "autoReplyEnabled",
      c.scenario_enabled AS "scenarioEnabled",
      c.status,
      c.updated_at,
      ct.phone_number,
      ct.name,
      ct.channel,
      ct.username,
      latest.body AS last_message,
      latest.direction AS "lastDirection",
      c.column_pinned_at AS "columnPinnedAt",
      (SELECT name FROM column_rules rule WHERE rule.id = c.column_pinned_rule_id) AS "columnPinnedRule",
      (c.status = 'open' AND latest.direction = 'inbound') AS "needsResponse",
      (SELECT COUNT(*)::int FROM messages m
        WHERE m.conversation_id = c.id
          AND m.direction = 'inbound'
          AND m.created_at > COALESCE((SELECT last_read_at FROM conversation_read_states rs WHERE rs.conversation_id = c.id AND rs.user_id = $2), '-infinity'::timestamptz)
      ) AS "unreadCount"
    FROM conversations c
    JOIN contacts ct ON ct.id = c.contact_id
    LEFT JOIN LATERAL (
      SELECT body, direction
      FROM messages
      WHERE conversation_id = c.id
      ORDER BY created_at DESC
      LIMIT 1
    ) latest ON true
    WHERE c.organization_id = $1 AND c.lead_column_id = ANY($3::uuid[])
    ORDER BY c.updated_at DESC
  `, [organizationId, userId, columns.rows.map((column) => column.id)]);
  const byColumn = new Map(columns.rows.map((column) => [column.id, []]));
  for (const lead of leads.rows) byColumn.get(lead.lead_column_id)?.push(lead);
  return columns.rows.map((column) => ({ ...column, leads: byColumn.get(column.id) || [] }));
};

exports.addColumn = async (organizationId, input) => {
  const data = validate(columnSchema, input);
  const boardId = await resolveBoardId(db, organizationId, data.boardId);
  try {
    const result = await db.query(`
      INSERT INTO lead_columns (organization_id, board_id, name, position)
      VALUES ($1, $3, $2, COALESCE((SELECT MAX(position) + 1 FROM lead_columns WHERE board_id = $3), 0))
      RETURNING id, name, position, board_id AS "boardId"
    `, [organizationId, data.name, boardId]);
    await realtime.publish(organizationId, 'lead.column_created');
    return result.rows[0];
  } catch (error) {
    if (error.code === '23505') {
      error.status = 409;
      error.message = 'Ya existe una columna con ese nombre en este dashboard';
    }
    throw error;
  }
};

exports.reorderColumns = async (organizationId, input) => {
  const data = validate(reorderSchema, input);
  const result = await db.transaction(async (client) => {
    // Lock the board's columns so two administrators cannot persist
    // conflicting orders at the same time. Cada dashboard se ordena por separado.
    const existing = await client.query(
      'SELECT id FROM lead_columns WHERE organization_id = $1 AND board_id = (SELECT board_id FROM lead_columns WHERE id = $2 AND organization_id = $1) FOR UPDATE',
      [organizationId, data.columnIds[0]],
    );
    const expectedIds = new Set(existing.rows.map((row) => row.id));
    const receivedIds = new Set(data.columnIds);
    if (expectedIds.size !== receivedIds.size || [...expectedIds].some((id) => !receivedIds.has(id))) {
      const error = new Error('The column order must include every column of the dashboard exactly once');
      error.status = 400;
      throw error;
    }
    await client.query(`
      UPDATE lead_columns AS columns
      SET position = ordered.position
      FROM unnest($2::uuid[]) WITH ORDINALITY AS ordered(id, position)
      WHERE columns.id = ordered.id AND columns.organization_id = $1
    `, [organizationId, data.columnIds]);
    return data.columnIds;
  });
  await realtime.publish(organizationId, 'lead.columns_reordered');
  return { columnIds: result };
};

exports.removeColumn = async (organizationId, columnId) => {
  const result = await db.transaction(async (client) => {
    const target = await client.query(
      'SELECT id, name, board_id FROM lead_columns WHERE id = $1 AND organization_id = $2',
      [columnId, organizationId],
    );
    if (!target.rows[0]) {
      const error = new Error('Lead column not found');
      error.status = 404;
      throw error;
    }
    // El reemplazo es otra columna del mismo dashboard.
    const replacement = await client.query(
      'SELECT id FROM lead_columns WHERE organization_id = $1 AND id <> $2 AND board_id IS NOT DISTINCT FROM $3 ORDER BY position ASC, created_at ASC LIMIT 1',
      [organizationId, columnId, target.rows[0].board_id ?? null],
    );
    if (!replacement.rows[0]) {
      const error = new Error('Cada dashboard necesita al menos una columna');
      error.status = 409;
      throw error;
    }
    const movedLeads = await remapColumns(client, organizationId, new Map([[columnId, replacement.rows[0].id]]));
    const moved = { rowCount: movedLeads };
    await client.query('DELETE FROM lead_columns WHERE id = $1 AND organization_id = $2', [columnId, organizationId]);
    return { deletedId: columnId, movedLeads: moved.rowCount, replacementId: replacement.rows[0].id };
  });
  await realtime.publish(organizationId, 'lead.column_removed');
  return result;
};

/** Pasa leads, reglas de columna y pasos de escenarios de unas columnas a otras (antes de borrarlas). */
const remapColumns = async (client, organizationId, map) => {
  let movedLeads = 0;
  for (const [from, to] of map) {
    const moved = await client.query(
      'UPDATE conversations SET lead_column_id = $1, column_pinned_at = NULL, column_pinned_rule_id = NULL, updated_at = now() WHERE organization_id = $2 AND lead_column_id = $3',
      [to, organizationId, from],
    );
    movedLeads += moved.rowCount || 0;
    await client.query('UPDATE column_rules SET column_id = $1, updated_at = now() WHERE organization_id = $2 AND column_id = $3', [to, organizationId, from]);
    await client.query(
      `UPDATE remarketing_move_rules SET
         after_send_column_id = CASE WHEN after_send_column_id = $3 THEN $1 ELSE after_send_column_id END,
         on_reply_column_id = CASE WHEN on_reply_column_id = $3 THEN $1 ELSE on_reply_column_id END, updated_at = now()
       WHERE organization_id = $2 AND $3 IN (after_send_column_id, on_reply_column_id)`,
      [to, organizationId, from],
    );
  }
  // Los escenarios que movían leads a esas columnas ahora los mueven a la de reemplazo.
  const scenarios = await client.query(
    "SELECT id, steps FROM automation_scenarios WHERE organization_id = $1 AND steps::text LIKE ANY($2::text[])",
    [organizationId, [...map.keys()].map((id) => `%${id}%`)],
  );
  for (const scenario of scenarios.rows) {
    const steps = (scenario.steps || []).map((step) => (step?.columnId && map.has(step.columnId) ? { ...step, columnId: map.get(step.columnId) } : step));
    await client.query('UPDATE automation_scenarios SET steps = $3::jsonb, updated_at = now() WHERE id = $1 AND organization_id = $2', [scenario.id, organizationId, JSON.stringify(steps)]);
  }
  return movedLeads;
};
exports.remapColumns = remapColumns;
exports.normalizedColumnName = normalizedColumnName;

exports.move = async (organizationId, conversationId, input) => {
  const data = validate(moveSchema, input);
  const result = await db.transaction(async (client) => {
    const column = await client.query(
      'SELECT id FROM lead_columns WHERE id = $1 AND organization_id = $2',
      [data.columnId, organizationId],
    );
    if (!column.rows[0]) {
      const error = new Error('Lead column not found');
      error.status = 404;
      throw error;
    }
    const conversation = await client.query(
      // Mover a mano libera el lead si una regla lo había fijado en su columna.
      'UPDATE conversations SET lead_column_id = $3, column_pinned_at = NULL, column_pinned_rule_id = NULL, updated_at = now() WHERE id = $1 AND organization_id = $2 RETURNING id, lead_column_id',
      [conversationId, organizationId, data.columnId],
    );
    if (!conversation.rows[0]) {
      const error = new Error('Conversation not found');
      error.status = 404;
      throw error;
    }
    return conversation.rows[0];
  });
  await realtime.publish(organizationId, 'lead.moved', result.id);
  return result;
};

exports.moveAllFromColumn = async (organizationId, sourceColumnId, input) => {
  const data = validate(bulkMoveSchema, input);
  if (sourceColumnId === data.targetColumnId) {
    const error = new Error('Elige una columna de destino distinta');
    error.status = 400;
    throw error;
  }
  const movedLeads = await db.transaction(async (client) => {
    const columns = await client.query(
      'SELECT id FROM lead_columns WHERE organization_id=$1 AND id = ANY($2::uuid[]) FOR UPDATE',
      [organizationId, [sourceColumnId, data.targetColumnId]],
    );
    if (columns.rowCount !== 2) {
      const error = new Error('La columna de origen o destino no fue encontrada');
      error.status = 404;
      throw error;
    }
    const moved = await client.query(
      `UPDATE conversations
       SET lead_column_id=$3, column_pinned_at=NULL, column_pinned_rule_id=NULL, updated_at=now()
       WHERE organization_id=$1 AND lead_column_id=$2`,
      [organizationId, sourceColumnId, data.targetColumnId],
    );
    return moved.rowCount;
  });
  await realtime.publish(organizationId, 'lead.bulk_moved');
  return { sourceColumnId, targetColumnId: data.targetColumnId, movedLeads };
};

// An unmatched customer message should be visible to a human. The column is
// intentionally looked up by name so each organization retains control of its
// own pipeline IDs and can still rename/reorder all other columns freely.
// Movimiento automático: respeta los leads fijados por una regla de columna.
const autoMove = async (organizationId, conversationId, columnId) => {
  const moved = await db.query(
    'UPDATE conversations SET lead_column_id=$3, updated_at=now() WHERE id=$1 AND organization_id=$2 AND column_pinned_at IS NULL RETURNING id',
    [conversationId, organizationId, columnId],
  );
  if (!moved.rows[0]) return false;
  await realtime.publish(organizationId, 'lead.moved', conversationId);
  return true;
};
exports.autoMove = autoMove;

// Columnas especiales («Requiere atención», «R-HOT»): primero las del dashboard donde está
// el chat; si ese dashboard no la tiene, la del principal.
const specialColumns = (organizationId, conversationId) => db.query(`
  SELECT column_row.id, column_row.name
  FROM lead_columns column_row JOIN lead_boards board ON board.id = column_row.board_id
  LEFT JOIN LATERAL (
    SELECT current_column.board_id FROM conversations c JOIN lead_columns current_column ON current_column.id = c.lead_column_id
    WHERE c.id = $2 AND c.organization_id = $1
  ) current ON true
  WHERE column_row.organization_id = $1
  ORDER BY (column_row.board_id = current.board_id) DESC NULLS LAST, board.is_default DESC, board.position, column_row.position
`, [organizationId, conversationId]);

exports.moveToAttention = async (organizationId, conversationId) => {
  const columns = await specialColumns(organizationId, conversationId);
  const target = columns.rows.find((column) => normalizedColumnName(column.name) === 'requiereatencion');
  if (!target) return false;
  return autoMove(organizationId, conversationId, target.id);
};

// R-HOT is a commercial outcome, not an automation state: a customer who
// answers a campaign or an approved template is explicitly showing renewed
// interest and should be surfaced in the pipeline immediately.
exports.moveToRemarketingHot = async (organizationId, conversationId) => {
  const columns = await specialColumns(organizationId, conversationId);
  const target = columns.rows.find((column) => normalizedColumnName(column.name) === 'rhot');
  if (!target) return false;
  const current = await db.query('SELECT lead_column_id FROM conversations WHERE id=$1 AND organization_id=$2', [conversationId, organizationId]);
  if (!current.rows[0] || current.rows[0].lead_column_id === target.id) return false;
  return autoMove(organizationId, conversationId, target.id);
};
