const { z } = require('zod');
const db = require('../lib/db');
const realtime = require('../lib/realtime');

const columnSchema = z.object({ name: z.string().trim().min(2).max(80) });
const moveSchema = z.object({ columnId: z.string().uuid() });

const validate = (schema, value) => {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const error = new Error(parsed.error.issues[0].message);
  error.status = 400;
  throw error;
};

const initialColumn = (client, organizationId) => client.query(
  'SELECT id FROM lead_columns WHERE organization_id = $1 ORDER BY position ASC, created_at ASC LIMIT 1',
  [organizationId],
);

exports.initialColumnId = async (client, organizationId) => {
  const result = await initialColumn(client, organizationId);
  if (!result.rows[0]) {
    const error = new Error('Lead pipeline is not configured');
    error.status = 500;
    throw error;
  }
  return result.rows[0].id;
};

exports.board = async (organizationId, userId) => {
  const columns = await db.query(
    'SELECT id, name, position FROM lead_columns WHERE organization_id = $1 ORDER BY position ASC, created_at ASC',
    [organizationId],
  );
  const leads = await db.query(`
    SELECT
      c.id,
      c.lead_column_id,
      c.status,
      c.updated_at,
      ct.phone_number,
      ct.name,
      latest.body AS last_message,
      (SELECT COUNT(*)::int FROM messages m
        WHERE m.conversation_id = c.id
          AND m.direction = 'inbound'
          AND m.created_at > COALESCE((SELECT last_read_at FROM conversation_read_states rs WHERE rs.conversation_id = c.id AND rs.user_id = $2), '-infinity'::timestamptz)
      ) AS "unreadCount"
    FROM conversations c
    JOIN contacts ct ON ct.id = c.contact_id
    LEFT JOIN LATERAL (
      SELECT body
      FROM messages
      WHERE conversation_id = c.id
      ORDER BY created_at DESC
      LIMIT 1
    ) latest ON true
    WHERE c.organization_id = $1
    ORDER BY c.updated_at DESC
  `, [organizationId, userId]);
  const byColumn = new Map(columns.rows.map((column) => [column.id, []]));
  for (const lead of leads.rows) byColumn.get(lead.lead_column_id)?.push(lead);
  return columns.rows.map((column) => ({ ...column, leads: byColumn.get(column.id) || [] }));
};

exports.addColumn = async (organizationId, input) => {
  const data = validate(columnSchema, input);
  try {
    const result = await db.query(`
      INSERT INTO lead_columns (organization_id, name, position)
      VALUES ($1, $2, COALESCE((SELECT MAX(position) + 1 FROM lead_columns WHERE organization_id = $1), 0))
      RETURNING id, name, position
    `, [organizationId, data.name]);
    await realtime.publish(organizationId, 'lead.column_created');
    return result.rows[0];
  } catch (error) {
    if (error.code === '23505') {
      error.status = 409;
      error.message = 'A column with this name already exists';
    }
    throw error;
  }
};

exports.removeColumn = async (organizationId, columnId) => {
  const result = await db.transaction(async (client) => {
    const target = await client.query(
      'SELECT id, name FROM lead_columns WHERE id = $1 AND organization_id = $2',
      [columnId, organizationId],
    );
    if (!target.rows[0]) {
      const error = new Error('Lead column not found');
      error.status = 404;
      throw error;
    }
    const replacement = await client.query(
      'SELECT id FROM lead_columns WHERE organization_id = $1 AND id <> $2 ORDER BY position ASC, created_at ASC LIMIT 1',
      [organizationId, columnId],
    );
    if (!replacement.rows[0]) {
      const error = new Error('At least one lead column is required');
      error.status = 409;
      throw error;
    }
    const moved = await client.query(
      'UPDATE conversations SET lead_column_id = $1, updated_at = now() WHERE organization_id = $2 AND lead_column_id = $3',
      [replacement.rows[0].id, organizationId, columnId],
    );
    await client.query('DELETE FROM lead_columns WHERE id = $1 AND organization_id = $2', [columnId, organizationId]);
    return { deletedId: columnId, movedLeads: moved.rowCount };
  });
  await realtime.publish(organizationId, 'lead.column_removed');
  return result;
};

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
      'UPDATE conversations SET lead_column_id = $3, updated_at = now() WHERE id = $1 AND organization_id = $2 RETURNING id, lead_column_id',
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
