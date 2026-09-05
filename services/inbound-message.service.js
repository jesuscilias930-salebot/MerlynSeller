const db = require('../lib/db');
const realtime = require('../lib/realtime');
const conversations = require('./conversation.service');
const leads = require('./lead.service');
const automations = require('./automation.service');
const metaConversions = require('./meta-conversions.service');

const textFor = (message) => message.text?.body || message.caption || `[${message.type || 'message'}]`;
const mediaIdFor = (message) => message?.[message.type]?.id || null;
const filenameFor = (message) => message?.[message.type]?.filename || null;
const statusFailure = (status) => {
  const error = status?.errors?.[0];
  if (!error) return null;
  const code = error.code ? String(error.code) : 'unknown';
  const detail = [error.title, error.error_data?.details || error.message]
    .filter(Boolean)
    .join(': ')
    .slice(0, 900);
  return { code, detail, stored: `[${code}]${detail ? ` ${detail}` : ''}` };
};

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
    // Meta adds context.id when the customer used WhatsApp's Reply action.
    // Resolve that provider id inside this conversation so unrelated messages
    // can never be linked merely because of a malformed webhook payload.
    const repliedProviderMessageId = message.context?.id || null;
    const inserted = await client.query(`
      INSERT INTO messages (organization_id, conversation_id, direction, type, body, media_id, filename, status, provider_message_id, reply_to_message_id)
      VALUES ($1, $2, 'inbound', $3, $4, $5, $6, 'received', $7,
        (SELECT id FROM messages WHERE organization_id=$1 AND conversation_id=$2 AND provider_message_id=$8))
      ON CONFLICT (provider_message_id) DO NOTHING
      RETURNING id
    `, [organizationId, conversation.rows[0].id, message.type || 'unknown', textFor(message), mediaIdFor(message), filenameFor(message), message.id, repliedProviderMessageId]);
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

const updateStatus = async (status) => {
  if (!status.id || !['sent', 'delivered', 'read', 'failed'].includes(status.status)) return;
  const failure = status.status === 'failed' ? statusFailure(status) : null;
  const result = await db.query(
    "UPDATE messages SET status = $2, error_code = CASE WHEN $2 = 'failed' THEN $3 ELSE error_code END, updated_at = now() WHERE provider_message_id = $1 RETURNING organization_id, conversation_id",
    [status.id, status.status, failure?.stored || 'Meta did not provide an error detail'],
  );
  if (result.rows[0]) {
    await realtime.publish(result.rows[0].organization_id, 'message.status_updated', result.rows[0].conversation_id);
    console.log(JSON.stringify({
      level: status.status === 'failed' ? 'warn' : 'info',
      message: status.status === 'failed' ? 'WhatsApp message delivery failed' : 'WhatsApp message status updated',
      status: status.status,
      conversationId: result.rows[0].conversation_id,
      ...(failure ? { metaErrorCode: failure.code, metaErrorDetail: failure.detail || undefined } : {}),
    }));
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
        if (stored?.inserted) {
          // CAPI reporting is intentionally isolated from message processing:
          // an unavailable Meta endpoint can never prevent a chat from being stored.
          await metaConversions.captureInboundReferral(account.rows[0].organization_id, stored.conversationId, message);
          await automations.processIncoming(account.rows[0].organization_id, stored.conversationId, message);
        }
      }
      for (const status of value.statuses || []) await updateStatus(status);
    }
  }
};
