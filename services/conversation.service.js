const { z } = require('zod');
const db = require('../lib/db');
const { outboundQueue } = require('../lib/queue');

const phone = z.string().trim().transform((value) => value.replace(/^\+/, '')).refine((value) => /^\d{8,15}$/.test(value), 'phoneNumber must be E.164');
const createSchema = z.object({ phoneNumber: phone, name: z.string().trim().max(120).optional() });
const textSchema = z.object({ body: z.string().trim().min(1).max(4096) });

const validation = (schema, value) => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) { const error = new Error(parsed.error.issues[0].message); error.status = 400; throw error; }
  return parsed.data;
};

exports.list = async (organizationId) => (await db.query(`SELECT c.id, c.status, c.updated_at, ct.phone_number, ct.name, (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.organization_id = $1 ORDER BY c.updated_at DESC`, [organizationId])).rows;
exports.messages = async (organizationId, conversationId) => (await db.query('SELECT id, direction, type, body, status, provider_message_id, created_at FROM messages WHERE organization_id = $1 AND conversation_id = $2 ORDER BY created_at ASC', [organizationId, conversationId])).rows;
exports.create = async (organizationId, input) => {
  const data = validation(createSchema, input);
  return db.transaction(async (client) => {
    const contact = await client.query('INSERT INTO contacts (organization_id, phone_number, name) VALUES ($1, $2, $3) ON CONFLICT (organization_id, phone_number) DO UPDATE SET name = COALESCE(EXCLUDED.name, contacts.name), updated_at = now() RETURNING id, phone_number, name', [organizationId, data.phoneNumber, data.name || null]);
    const conversation = await client.query("INSERT INTO conversations (organization_id, contact_id) VALUES ($1, $2) ON CONFLICT (organization_id, contact_id) DO UPDATE SET updated_at = now() RETURNING id, status, updated_at", [organizationId, contact.rows[0].id]);
    return { ...conversation.rows[0], contact: contact.rows[0] };
  });
};
exports.queueText = async (organizationId, conversationId, input) => {
  const data = validation(textSchema, input);
  const result = await db.query('INSERT INTO messages (organization_id, conversation_id, direction, type, body, status) SELECT $1, id, $3, $4, $5, $6 FROM conversations WHERE id = $2 AND organization_id = $1 RETURNING id', [organizationId, conversationId, 'outbound', 'text', data.body, 'pending']);
  if (!result.rows[0]) { const error = new Error('Conversation not found'); error.status = 404; throw error; }
  await outboundQueue().add('send-text', { messageId: result.rows[0].id }, { jobId: result.rows[0].id });
  return { id: result.rows[0].id, status: 'pending' };
};
