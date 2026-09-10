const { z } = require('zod');
const db = require('../lib/db');
const { outboundQueue } = require('../lib/queue');
const leads = require('./lead.service');
const messageService = require('./message.service');
const realtime = require('../lib/realtime');

const phone = z.string().trim().transform((value) => value.replace(/^\+/, '')).refine((value) => /^\d{8,15}$/.test(value), 'phoneNumber must be E.164');
const createSchema = z.object({ phoneNumber: phone, name: z.string().trim().max(120).optional() });
const textSchema = z.object({ body: z.string().trim().min(1).max(4096), replyToMessageId: z.string().uuid().optional() });
const autoReplySchema = z.object({ enabled: z.boolean() });
const scenarioSchema = z.object({ enabled: z.boolean() });
const documentSchema = z.object({
  mediaId: z.string().trim().min(1).max(256),
  filename: z.string().trim().min(1).max(240).optional(),
  caption: z.string().trim().max(1024).optional(),
});
const ctaUrlSchema = z.object({
  header: z.string().trim().max(60).optional(),
  headerImageUrl: z.string().trim().url().max(2000).optional(),
  body: z.string().trim().min(1).max(1024),
  footer: z.string().trim().max(60).optional(),
  buttonText: z.string().trim().min(1).max(20),
  url: z.string().trim().url().max(2000),
});
const templateMessageSchema = z.object({
  templateId: z.string().uuid(),
  manualValues: z.record(z.string(), z.string().trim().max(1024)).optional(),
});
const reactionSchema = z.object({
  emoji: z.string().max(32).refine((value) => value === '' || value.trim().length > 0, 'emoji must be an emoji or empty to remove it'),
});

const validation = (schema, value) => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) { const error = new Error(parsed.error.issues[0].message); error.status = 400; throw error; }
  return parsed.data;
};

exports.list = async (organizationId, userId) => (await db.query(`
  SELECT c.id, c.contact_id AS "contactId", c.status, c.updated_at, c.auto_reply_enabled AS "autoReplyEnabled", c.scenario_enabled AS "scenarioEnabled", c.lead_column_id AS "leadColumnId", ct.phone_number, ct.name,
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
exports.messages = async (organizationId, conversationId, userId) => (await db.query(`
  SELECT m.id, m.direction, m.type, m.body, m.media_id, m.filename, m.status, m.error_code, m.provider_message_id, m.referral, m.message_metadata AS "messageMetadata", m.created_at,
    (m.deleted_at IS NOT NULL) AS "deletedForEveryone",
    m.reply_to_message_id AS "replyToMessageId", replied.body AS "replyToBody", replied.type AS "replyToType", replied.direction AS "replyToDirection",
    COALESCE((
      SELECT json_agg(json_build_object('emoji', reaction.emoji, 'actorDirection', reaction.actor_direction) ORDER BY reaction.created_at)
      FROM message_reactions reaction
      WHERE reaction.organization_id=m.organization_id
        AND reaction.conversation_id=m.conversation_id
        AND reaction.target_provider_message_id=m.provider_message_id
    ), '[]'::json) AS reactions
  FROM messages m
  LEFT JOIN messages replied ON replied.id = m.reply_to_message_id
  WHERE m.organization_id = $1 AND m.conversation_id = $2
    AND NOT EXISTS (SELECT 1 FROM message_user_deletions hidden WHERE hidden.message_id=m.id AND hidden.user_id=$3)
  ORDER BY m.created_at ASC
`, [organizationId, conversationId, userId])).rows;

exports.deleteMessage = async (organizationId, conversationId, userId, messageId, scope) => {
  const data = validation(z.object({ scope: z.enum(['for_me', 'for_everyone']) }), { scope });
  const message = (await db.query(
    `SELECT id,direction,status,provider_message_id AS "providerMessageId",deleted_at AS "deletedAt"
     FROM messages WHERE id=$1 AND organization_id=$2 AND conversation_id=$3`,
    [messageId, organizationId, conversationId],
  )).rows[0];
  if (!message) { const error = new Error('Message not found'); error.status = 404; throw error; }
  if (data.scope === 'for_me') {
    await db.query(
      `INSERT INTO message_user_deletions (message_id,user_id) VALUES ($1,$2)
       ON CONFLICT (message_id,user_id) DO NOTHING`,
      [messageId, userId],
    );
    return { scope: data.scope, deleted: true };
  }
  if (message.direction !== 'outbound') {
    const error = new Error('Solo los mensajes enviados por tu negocio se pueden eliminar para todos');
    error.status = 400;
    throw error;
  }
  if (message.deletedAt) return { scope: data.scope, deleted: true };
  if (message.status !== 'pending') {
    if (!message.providerMessageId) {
      const error = new Error('El mensaje todavía no está disponible para eliminarse en WhatsApp');
      error.status = 400;
      throw error;
    }
    await messageService.deleteMessage(message.providerMessageId);
  }
  await db.query(
    `UPDATE messages SET deleted_at=now(),deleted_by_user_id=$4,status=CASE WHEN status='pending' THEN 'deleted' ELSE status END,updated_at=now()
     WHERE id=$1 AND organization_id=$2 AND conversation_id=$3`,
    [messageId, organizationId, conversationId, userId],
  );
  await realtime.publish(organizationId, 'message.deleted', conversationId);
  return { scope: data.scope, deleted: true };
};

exports.reactToMessage = async (organizationId, conversationId, messageId, input) => {
  const data = validation(reactionSchema, input);
  const target = await db.query(
    `SELECT message.provider_message_id, contact.phone_number
     FROM messages message
     JOIN conversations conversation ON conversation.id=message.conversation_id
     JOIN contacts contact ON contact.id=conversation.contact_id
     WHERE message.id=$1 AND message.organization_id=$2 AND message.conversation_id=$3
       AND message.direction='inbound'`,
    [messageId, organizationId, conversationId],
  );
  if (!target.rows[0]?.provider_message_id) {
    const error = new Error('Solo puedes reaccionar a un mensaje recibido que ya esté disponible en WhatsApp');
    error.status = 400;
    throw error;
  }
  await messageService.sendReaction({
    to: target.rows[0].phone_number,
    messageId: target.rows[0].provider_message_id,
    emoji: data.emoji,
  });
  if (data.emoji === '') {
    await db.query(
      `DELETE FROM message_reactions
       WHERE organization_id=$1 AND conversation_id=$2 AND target_provider_message_id=$3 AND actor_direction='outbound'`,
      [organizationId, conversationId, target.rows[0].provider_message_id],
    );
  } else {
    await db.query(
      `INSERT INTO message_reactions
         (organization_id, conversation_id, target_provider_message_id, actor_direction, emoji)
       VALUES ($1, $2, $3, 'outbound', $4)
       ON CONFLICT (organization_id, conversation_id, target_provider_message_id, actor_direction)
       DO UPDATE SET emoji=EXCLUDED.emoji, updated_at=now()`,
      [organizationId, conversationId, target.rows[0].provider_message_id, data.emoji],
    );
  }
  await realtime.publish(organizationId, 'message.reaction_updated', conversationId);
  return { emoji: data.emoji };
};
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
exports.setScenarioEnabled = async (organizationId, conversationId, input) => {
  const data = validation(scenarioSchema, input);
  const result = await db.query('UPDATE conversations SET scenario_enabled=$3,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING scenario_enabled AS "scenarioEnabled"', [conversationId, organizationId, data.enabled]);
  if (!result.rows[0]) { const error = new Error('Conversation not found'); error.status = 404; throw error; }
  if (!data.enabled) await completeScenario(organizationId, conversationId);
  return result.rows[0];
};
const completeScenario = (organizationId, conversationId) => db.query('UPDATE conversation_scenario_states SET completed_at=now(),updated_at=now() WHERE organization_id=$1 AND conversation_id=$2 AND completed_at IS NULL', [organizationId, conversationId]);
exports.disableScenariosForHuman = (organizationId, conversationId) => exports.setScenarioEnabled(organizationId, conversationId, { enabled: false });
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

exports.queueCtaUrl = async (organizationId, conversationId, input) => {
  const data = validation(ctaUrlSchema, input);
  if (!/^https:\/\//i.test(data.url)) { const error = new Error('url must use HTTPS'); error.status = 400; throw error; }
  if (data.headerImageUrl && !/^https:\/\//i.test(data.headerImageUrl)) { const error = new Error('La URL de la imagen del encabezado debe usar HTTPS.'); error.status = 400; throw error; }
  const result = await db.query(
    "INSERT INTO messages (organization_id, conversation_id, direction, type, body, media_id, status) SELECT $1, id, 'outbound', 'interactive', $3, $4, 'pending' FROM conversations WHERE id=$2 AND organization_id=$1 RETURNING id",
    [organizationId, conversationId, JSON.stringify(data), null],
  );
  if (!result.rows[0]) { const error = new Error('Conversation not found'); error.status = 404; throw error; }
  await outboundQueue().add('send-cta-url', { messageId: result.rows[0].id }, { jobId: result.rows[0].id });
  return { id: result.rows[0].id, status: 'pending', type: 'interactive' };
};

exports.queueTemplate = async (organizationId, conversationId, input) => {
  const data = validation(templateMessageSchema, input);
  const templates = require('./whatsapp-template.service');
  const resolved = await templates.resolveForConversation(organizationId, conversationId, data.templateId, data.manualValues || {});
  const payload = { templateName: resolved.template.name, language: resolved.template.language, components: resolved.components, templateId: resolved.template.id };
  const result = await db.query(
    "INSERT INTO messages (organization_id, conversation_id, direction, type, body, status) SELECT $1, id, 'outbound', 'template', $3, 'pending' FROM conversations WHERE id=$2 AND organization_id=$1 RETURNING id",
    [organizationId, conversationId, JSON.stringify(payload)],
  );
  if (!result.rows[0]) { const error = new Error('Conversation not found'); error.status = 404; throw error; }
  await outboundQueue().add('send-template', { messageId: result.rows[0].id }, { jobId: result.rows[0].id });
  return { id: result.rows[0].id, status: 'pending', type: 'template' };
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
    "INSERT INTO messages (organization_id, conversation_id, direction, type, body, media_id, filename, status) SELECT $1, id, 'outbound', 'document', $3, $4, $5, 'pending' FROM conversations WHERE id = $2 AND organization_id = $1 RETURNING id",
    [organizationId, conversationId, input.caption || null, uploaded.mediaId, uploaded.filename],
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
    "INSERT INTO messages (organization_id, conversation_id, direction, type, body, media_id, status) SELECT $1, id, 'outbound', $3, $4, $5, 'pending' FROM conversations WHERE id = $2 AND organization_id = $1 RETURNING id",
    [organizationId, conversationId, type, input.caption || null, uploaded.mediaId],
  );
  if (!result.rows[0]) { const error = new Error('Conversation not found'); error.status = 404; throw error; }
  await outboundQueue().add(`send-${type}`, { messageId: result.rows[0].id }, { jobId: result.rows[0].id });
  return { id: result.rows[0].id, status: 'pending', type };
};

// Reuses a Meta media id already uploaded by the organization. Scenario
// evidence is therefore uploaded only once and can be sent to many leads.
exports.queueExistingMedia = async (organizationId, conversationId, type, mediaId, caption) => {
  if (!['image', 'sticker'].includes(type)) { const error = new Error('Only images and stickers can be reused'); error.status = 400; throw error; }
  const result = await db.query(
    "INSERT INTO messages (organization_id, conversation_id, direction, type, body, media_id, status) SELECT $1, id, 'outbound', $3, $4, $5, 'pending' FROM conversations WHERE id = $2 AND organization_id = $1 RETURNING id",
    [organizationId, conversationId, type, type === 'image' ? caption || null : null, mediaId],
  );
  if (!result.rows[0]) { const error = new Error('Conversation not found'); error.status = 404; throw error; }
  await outboundQueue().add(`send-${type}`, { messageId: result.rows[0].id }, { jobId: result.rows[0].id });
  return { id: result.rows[0].id, status: 'pending', type };
};

exports.queueSavedSticker = async (organizationId, conversationId, stickerId) => {
  const sticker = await db.query('SELECT media_id FROM saved_stickers WHERE id=$1 AND organization_id=$2', [stickerId, organizationId]);
  if (!sticker.rows[0]) { const error = new Error('Sticker not found'); error.status = 404; throw error; }
  return exports.queueExistingMedia(organizationId, conversationId, 'sticker', sticker.rows[0].media_id);
};

exports.queueEntrepreneurPackages = async (organizationId, conversationId, input) => {
  const parsed = z.object({
    packageIds: z.array(z.string().uuid()).min(1).max(20).optional(),
    imageIds: z.array(z.string().uuid()).min(1).max(50).optional(),
  }).refine((value) => Boolean(value.packageIds?.length) !== Boolean(value.imageIds?.length), 'Select packageIds or imageIds, not both').safeParse(input);
  if (!parsed.success) {
    const error = new Error(parsed.error.issues[0].message);
    error.status = 400;
    throw error;
  }
  if (parsed.data.imageIds) {
    const requestedIds = parsed.data.imageIds;
    const images = await db.query(
      `SELECT image.id, image.media_id AS "mediaId", COALESCE(image.caption, p.caption) AS caption
       FROM entrepreneur_package_images image
       JOIN entrepreneur_packages p ON p.id=image.package_id
       WHERE p.organization_id=$1 AND image.id = ANY($2::uuid[])`,
      [organizationId, requestedIds],
    );
    const byId = new Map(images.rows.map((image) => [image.id, image]));
    if (byId.size !== requestedIds.length) {
      const error = new Error('Una o más imágenes seleccionadas no fueron encontradas');
      error.status = 404;
      throw error;
    }
    const queued = [];
    for (const imageId of requestedIds) {
      const image = byId.get(imageId);
      queued.push(await exports.queueExistingMedia(organizationId, conversationId, 'image', image.mediaId, image.caption));
    }
    return { queued };
  }
  const requestedIds = parsed.data.packageIds;
  const templates = await db.query(
    `SELECT p.id, p.caption AS group_caption, COALESCE(json_agg(json_build_object('mediaId', image.media_id, 'caption', image.caption) ORDER BY image.position, image.created_at) FILTER (WHERE image.id IS NOT NULL), '[]'::json) AS images
     FROM entrepreneur_packages p LEFT JOIN entrepreneur_package_images image ON image.package_id=p.id
     WHERE p.organization_id=$1 AND p.id = ANY($2::uuid[]) GROUP BY p.id, p.caption`,
    [organizationId, requestedIds],
  );
  const byId = new Map(templates.rows.map((row) => [row.id, row]));
  if (byId.size !== requestedIds.length) {
    const error = new Error('One or more entrepreneur packages were not found');
    error.status = 404;
    throw error;
  }
  // Preserve collection and image order; every image becomes its own queued
  // WhatsApp message and is delivered by the existing outbound worker.
  const queued = [];
  for (const packageId of requestedIds) {
    const item = byId.get(packageId);
    if (!item.images.length) {
      const error = new Error('El bundle seleccionado aún no tiene fotografías');
      error.status = 400;
      throw error;
    }
    for (const image of item.images) queued.push(await exports.queueExistingMedia(organizationId, conversationId, 'image', image.mediaId, image.caption || item.group_caption));
  }
  return { queued };
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
