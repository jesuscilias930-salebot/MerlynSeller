const db = require('../lib/db');
const realtime = require('../lib/realtime');

const textFor = (message) => message.text?.body || message.caption || `[${message.type || 'message'}]`;

const saveMessage = async (organizationId, message) => {
  if (!message.id || !message.from) return;
  const conversationId = await db.transaction(async (client) => {
    const contact = await client.query('INSERT INTO contacts (organization_id, phone_number) VALUES ($1, $2) ON CONFLICT (organization_id, phone_number) DO UPDATE SET updated_at = now() RETURNING id', [organizationId, message.from]);
    const conversation = await client.query("INSERT INTO conversations (organization_id, contact_id) VALUES ($1, $2) ON CONFLICT (organization_id, contact_id) DO UPDATE SET updated_at = now(), status = 'open' RETURNING id", [organizationId, contact.rows[0].id]);
    await client.query("INSERT INTO messages (organization_id, conversation_id, direction, type, body, status, provider_message_id) VALUES ($1, $2, 'inbound', $3, $4, 'received', $5) ON CONFLICT (provider_message_id) DO NOTHING", [organizationId, conversation.rows[0].id, message.type || 'unknown', textFor(message), message.id]);
    return conversation.rows[0].id;
  });
  await realtime.publish(organizationId, 'message.received', conversationId);
};

const updateStatus = async (status) => {
  if (!status.id || !['sent', 'delivered', 'read', 'failed'].includes(status.status)) return;
  const result = await db.query('UPDATE messages SET status = $2, updated_at = now() WHERE provider_message_id = $1 RETURNING organization_id, conversation_id', [status.id, status.status]);
  if (result.rows[0]) await realtime.publish(result.rows[0].organization_id, 'message.status_updated', result.rows[0].conversation_id);
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
      for (const message of value.messages || []) await saveMessage(account.rows[0].organization_id, message);
      for (const status of value.statuses || []) await updateStatus(status);
    }
  }
};
