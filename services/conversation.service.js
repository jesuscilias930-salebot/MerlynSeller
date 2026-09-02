const { z } = require('zod');
const db = require('../lib/db');
const { outboundQueue } = require('../lib/queue');
const leads = require('./lead.service');
const messageService = require('./message.service');

const phone = z.string().trim().transform((value) => value.replace(/^\+/, '')).refine((value) => /^\d{8,15}$/.test(value), 'phoneNumber must be E.164');
const createSchema = z.object({ phoneNumber: phone, name: z.string().trim().max(120).optional() });
const textSchema = z.object({ body: z.string().trim().min(1).max(4096), replyToMessageId: z.string().uuid().optional() });
const autoReplySchema = z.object({ enabled: z.boolean() });
const documentSchema = z.object({
  mediaId: z.string().trim().min(1).max(256),
  filename: z.string().trim().min(1).max(240).optional(),
  caption: z.string().trim().max(1024).optional(),
});

const validation = (schema, value) => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) { const error = new Error(parsed.error.issues[0].message); error.status = 400; throw error; }
  return parsed.data;
};

exports.list = async (organizationId, userId) => (await db.query(`
  SELECT c.id, c.contact_id AS "contactId", c.status, c.updated_at, c.auto_reply_enabled AS "autoReplyEnabled", c.lead_column_id AS "leadColumnId", ct.phone_number, ct.name,
    latest.body AS last_message,
    latest.direction AS "lastDirection",
    (c.status = 'open' AND latest.direction = 'inbound') AS "needsResponse",
    (SELECT COUNT(*)::int FROM messages m
      WHERE m.conversation_id = c.id
        AND m.direction = 'inbound'
        AND m.created_at > COALESCE((SELECT last_read_at FROM conversation_read_states rs WHERE rs.conversation_id = c.id AND rs.user_id = $2), '-infinity'::timestamptz)
    ) AS "unreadCount"
  FROM conversations c
  JOIN contacts ct ON ct.id = c.contact_id
  LEFT JOIN LATERAL (
    SELECT body, direction FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1
  ) latest ON true
  WHERE c.organization_id = $1
  ORDER BY c.updated_at DESC
`, [organizationId, userId])).rows;
exports.messages = async (organizationId, conversationId) => (await db.query(`
  SELECT m.id, m.direction, m.type, m.body, m.media_id, m.filename, m.status, m.error_code, m.provider_message_id, m.created_at,
    m.reply_to_message_id AS "replyToMessageId", replied.body AS "replyToBody", replied.type AS "replyToType", replied.direction AS "replyToDirection"
  FROM messages m
  LEFT JOIN messages replied ON replied.id = m.reply_to_message_id
  WHERE m.organization_id = $1 AND m.conversation_id = $2
  ORDER BY m.created_at ASC
`, [organizationId, conversationId])).rows;
exports.documentOptions = async (organizationId, conversationId) => {
  const conversation = await db.query('SELECT 1 FROM conversations WHERE id = $1 AND organization_id = $2', [conversationId, organizationId]);
  if (!conversation.rows[0]) { const error = new Error('Conversation not found'); error.status = 404; throw error; }
  return (await db.query(`
    WITH document_sources AS (
      SELECT media_id, COALESCE(filename, 'Documento') AS filename, body AS caption, created_at
      FROM messages
      WHERE organization_id = $1 AND type = 'document' AND media_id IS NOT NULL
      UNION ALL
      SELECT media_id, COALESCE(filename, 'Catalogo') AS filename, caption, updated_at AS created_at
      FROM catalog_documents
      WHERE organization_id = $1
      UNION ALL
      SELECT media_id, filename, caption, updated_at AS created_at
      FROM document_templates
      WHERE organization_id = $1
    ), latest AS (
      SELECT DISTINCT ON (media_id) media_id, filename, caption, created_at
      FROM document_sources
      ORDER BY media_id, created_at DESC
    )
    SELECT media_id AS "mediaId", filename, caption, created_at
    FROM latest
    ORDER BY created_at DESC
  `, [organizationId])).rows;
};
exports.markRead = async (organizationId, userId, conversationId) => {
  const result = await db.query(`
    INSERT INTO conversation_read_states (conversation_id, user_id, last_read_at)
    SELECT id, $3, now() FROM conversations WHERE id = $1 AND organization_id = $2
    ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = EXCLUDED.last_read_at
    RETURNING conversation_id
  `, [conversationId, organizationId, userId]);
  if (!result.rows[0]) { const error = new Error('Conversation not found'); error.status = 404; throw error; }
  return { marked: true };
};
exports.setAutoReply = async (organizationId, conversationId, input) => {
  const data = validation(autoReplySchema, input);
  const result = await db.query('UPDATE conversations SET auto_reply_enabled=$3, updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING auto_reply_enabled AS "autoReplyEnabled"', [conversationId, organizationId, data.enabled]);
  if (!result.rows[0]) { const error = new Error('Conversation not found'); error.status = 404; throw error; }
  return result.rows[0];
};
// Test-reset helper: the contact is intentionally kept so its visible name and
// phone number remain available, while messages and scenario state are removed
// through the conversation foreign-key cascades.
exports.remove = async (organizationId, conversationId) => {
  const result = await db.query('DELETE FROM conversations WHERE id=$1 AND organization_id=$2 RETURNING id', [conversationId, organizationId]);
  if (!result.rows[0]) { const error = new Error('Conversation not found'); error.status = 404; throw error; }
  return { deleted: true };
};
exports.create = async (organizationId, input) => {
  const data = validation(createSchema, input);
  return db.transaction(async (client) => {
    const contact = await client.query('INSERT INTO contacts (organization_id, phone_number, name) VALUES ($1, $2, $3) ON CONFLICT (organization_id, phone_number) DO UPDATE SET name = COALESCE(EXCLUDED.name, contacts.name), updated_at = now() RETURNING id, phone_number, name', [organizationId, data.phoneNumber, data.name || null]);
    const initialColumnId = await leads.initialColumnId(client, organizationId);
    const conversation = await client.query("INSERT INTO conversations (organization_id, contact_id, lead_column_id) VALUES ($1, $2, $3) ON CONFLICT (organization_id, contact_id) DO UPDATE SET updated_at = now(), lead_column_id = COALESCE(conversations.lead_column_id, EXCLUDED.lead_column_id) RETURNING id, status, updated_at", [organizationId, contact.rows[0].id, initialColumnId]);
    return { ...conversation.rows[0], contact: contact.rows[0] };
  });
};
exports.queueText = async (organizationId, conversationId, input) => {
  const data = validation(textSchema, input);
  if (data.replyToMessageId) {
    const referenced = await db.query('SELECT provider_message_id FROM messages WHERE id=$1 AND organization_id=$2 AND conversation_id=$3', [data.replyToMessageId, organizationId, conversationId]);
    if (!referenced.rows[0]?.provider_message_id) { const error = new Error('El mensaje seleccionado todavía no está disponible para responder'); error.status = 400; throw error; }
  }
  const result = await db.query('INSERT INTO messages (organization_id, conversation_id, direction, type, body, status, reply_to_message_id) SELECT $1, id, $3, $4, $5, $6, $7 FROM conversations WHERE id = $2 AND organization_id = $1 RETURNING id', [organizationId, conversationId, 'outbound', 'text', data.body, 'pending', data.replyToMessageId || null]);
  if (!result.rows[0]) { const error = new Error('Conversation not found'); error.status = 404; throw error; }
  await outboundQueue().add('send-text', { messageId: result.rows[0].id }, { jobId: result.rows[0].id });
  return { id: result.rows[0].id, status: 'pending' };
};

exports.queueDocument = async (organizationId, conversationId, input) => {
  const data = validation(documentSchema, input);
  const result = await db.query(
    "INSERT INTO messages (organization_id, conversation_id, direction, type, body, media_id, filename, status) SELECT $1, id, 'outbound', 'document', $3, $4, $5, 'pending' FROM conversations WHERE id = $2 AND organization_id = $1 RETURNING id",
    [organizationId, conversationId, data.caption || null, data.mediaId, data.filename || null],
  );
  if (!result.rows[0]) { const error = new Error('Conversation not found'); error.status = 404; throw error; }
  await outboundQueue().add('send-document', { messageId: result.rows[0].id }, { jobId: result.rows[0].id });
  return { id: result.rows[0].id, status: 'pending', type: 'document' };
};

exports.queueUploadedDocument = async (organizationId, conversationId, input) => {
  const uploaded = await messageService.uploadMedia(input);
  const result = await db.query(
    "INSERT INTO messages (organization_id, conversation_id, direction, type, media_id, filename, status) SELECT $1, id, 'outbound', 'document', $3, $4, 'pending' FROM conversations WHERE id = $2 AND organization_id = $1 RETURNING id",
    [organizationId, conversationId, uploaded.mediaId, uploaded.filename],
  );
  if (!result.rows[0]) { const error = new Error('Conversation not found'); error.status = 404; throw error; }
  await outboundQueue().add('send-document', { messageId: result.rows[0].id }, { jobId: result.rows[0].id });
  return { id: result.rows[0].id, status: 'pending', type: 'document', mediaId: uploaded.mediaId };
};

exports.queueAudio = async (organizationId, conversationId, input) => {
  const audio = await messageService.prepareAudio(input);
  const uploaded = await messageService.uploadMedia(audio);
  const result = await db.query(
    "INSERT INTO messages (organization_id, conversation_id, direction, type, media_id, status) SELECT $1, id, 'outbound', 'audio', $3, 'pending' FROM conversations WHERE id = $2 AND organization_id = $1 RETURNING id",
    [organizationId, conversationId, uploaded.mediaId],
  );
  if (!result.rows[0]) {
    const error = new Error('Conversation not found');
    error.status = 404;
    throw error;
  }
  await outboundQueue().add('send-audio', { messageId: result.rows[0].id }, { jobId: result.rows[0].id });
  return { id: result.rows[0].id, status: 'pending', type: 'audio' };
};

exports.queueMedia = async (organizationId, conversationId, type, input) => {
  const media = type === 'video' ? await messageService.prepareVideo(input) : input;
  const uploaded = await messageService.uploadMedia(media);
  const result = await db.query(
    "INSERT INTO messages (organization_id, conversation_id, direction, type, media_id, status) SELECT $1, id, 'outbound', $3, $4, 'pending' FROM conversations WHERE id = $2 AND organization_id = $1 RETURNING id",
    [organizationId, conversationId, type, uploaded.mediaId],
  );
  if (!result.rows[0]) { const error = new Error('Conversation not found'); error.status = 404; throw error; }
  await outboundQueue().add(`send-${type}`, { messageId: result.rows[0].id }, { jobId: result.rows[0].id });
  return { id: result.rows[0].id, status: 'pending', type };
};

// Reuses a Meta media id already uploaded by the organization. Scenario
// evidence is therefore uploaded only once and can be sent to many leads.
exports.queueExistingMedia = async (organizationId, conversationId, type, mediaId, caption) => {
  if (type !== 'image') { const error = new Error('Only images can be reused as scenario evidence'); error.status = 400; throw error; }
  const result = await db.query(
    "INSERT INTO messages (organization_id, conversation_id, direction, type, body, media_id, status) SELECT $1, id, 'outbound', 'image', $3, $4, 'pending' FROM conversations WHERE id = $2 AND organization_id = $1 RETURNING id",
    [organizationId, conversationId, caption || null, mediaId],
  );
  if (!result.rows[0]) { const error = new Error('Conversation not found'); error.status = 404; throw error; }
  await outboundQueue().add('send-image', { messageId: result.rows[0].id }, { jobId: result.rows[0].id });
  return { id: result.rows[0].id, status: 'pending', type: 'image' };
};

exports.media = async (organizationId, conversationId, messageId) => {
  const result = await db.query(
    "SELECT type, media_id FROM messages WHERE id = $1 AND conversation_id = $2 AND organization_id = $3 AND type IN ('audio', 'sticker', 'image', 'video', 'document')",
    [messageId, conversationId, organizationId],
  );
  if (!result.rows[0]?.media_id) {
    const error = new Error('Media not found');
    error.status = 404;
    throw error;
  }
  return messageService.downloadMedia(result.rows[0].media_id);
};
