const db = require('../lib/db');
const realtime = require('../lib/realtime');
const conversations = require('./conversation.service');
const leads = require('./lead.service');

const textFor = (message) => message.text?.body || message.caption || `[${message.type || 'message'}]`;
const mediaIdFor = (message) => message?.[message.type]?.id || null;

const saveMessage = async (organizationId, message, contactName) => {
  if (!message.id || !message.from) return;
  const result = await db.transaction(async (client) => {
    const contact = await client.query(
      `INSERT INTO contacts (organization_id, phone_number, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, phone_number) DO UPDATE SET
         name = COALESCE(EXCLUDED.name, contacts.name),
         updated_at = now()
       RETURNING id`,
      [organizationId, message.from, contactName || null],
    );
    const initialColumnId = await leads.initialColumnId(client, organizationId);
    const conversation = await client.query("INSERT INTO conversations (organization_id, contact_id, lead_column_id) VALUES ($1, $2, $3) ON CONFLICT (organization_id, contact_id) DO UPDATE SET updated_at = now(), status = 'open', lead_column_id = COALESCE(conversations.lead_column_id, EXCLUDED.lead_column_id) RETURNING id", [organizationId, contact.rows[0].id, initialColumnId]);
    const inserted = await client.query("INSERT INTO messages (organization_id, conversation_id, direction, type, body, media_id, status, provider_message_id) VALUES ($1, $2, 'inbound', $3, $4, $5, 'received', $6) ON CONFLICT (provider_message_id) DO NOTHING RETURNING id", [organizationId, conversation.rows[0].id, message.type || 'unknown', textFor(message), mediaIdFor(message), message.id]);
    return { conversationId: conversation.rows[0].id, inserted: inserted.rowCount > 0 };
  });
  if (result.inserted) {
    await realtime.publish(organizationId, 'message.received', result.conversationId);
    console.log(JSON.stringify({
      level: 'info',
      message: 'Incoming WhatsApp message stored',
      messageType: message.type || 'unknown',
      conversationId: result.conversationId,
    }));
  }
  return result;
};

const normalize = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, '')
  .replace(/\s+/g, ' ')
  .trim();

const queueCatalogIfRequested = async (organizationId, conversationId, message) => {
  if (message.type !== 'text') return;
  const catalog = await db.query('SELECT media_id, filename, caption, trigger_phrase FROM catalog_documents WHERE organization_id = $1', [organizationId]);
  const document = catalog.rows[0];
  const triggerPhrase = normalize(document?.trigger_phrase);
  if (!document || !triggerPhrase || !normalize(message.text?.body).includes(triggerPhrase)) return;

  const queued = await conversations.queueDocument(organizationId, conversationId, {
    mediaId: document.media_id,
    filename: document.filename || undefined,
    caption: document.caption || undefined,
  });
  console.log(JSON.stringify({ level: 'info', message: 'Catalog document queued automatically', conversationId, messageId: queued.id }));
};

const updateStatus = async (status) => {
  if (!status.id || !['sent', 'delivered', 'read', 'failed'].includes(status.status)) return;
  const result = await db.query('UPDATE messages SET status = $2, updated_at = now() WHERE provider_message_id = $1 RETURNING organization_id, conversation_id', [status.id, status.status]);
  if (result.rows[0]) {
    await realtime.publish(result.rows[0].organization_id, 'message.status_updated', result.rows[0].conversation_id);
    console.log(JSON.stringify({ level: 'info', message: 'WhatsApp message status updated', status: status.status, conversationId: result.rows[0].conversation_id }));
  }
};

exports.process = async (payload) => {
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const phoneNumberId = value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;
      const account = await db.query('SELECT organization_id FROM whatsapp_accounts WHERE phone_number_id = $1', [phoneNumberId]);
      if (!account.rows[0]) {
        console.warn(JSON.stringify({ level: 'warn', message: 'Webhook ignored: no organization is connected to this phone number' }));
        continue;
      }
      const contactNames = new Map((value.contacts || [])
        .filter((contact) => contact?.wa_id && contact.profile?.name)
        .map((contact) => [contact.wa_id, contact.profile.name.trim()]));
      for (const message of value.messages || []) {
        const stored = await saveMessage(
          account.rows[0].organization_id,
          message,
          contactNames.get(message.from),
        );
        if (stored?.inserted) await queueCatalogIfRequested(account.rows[0].organization_id, stored.conversationId, message);
      }
      for (const status of value.statuses || []) await updateStatus(status);
    }
  }
};
