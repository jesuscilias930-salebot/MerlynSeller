require('dotenv').config();
const { Worker } = require('bullmq');
const { connection } = require('./lib/queue');
const db = require('./lib/db');
const messageService = require('./services/message.service');
const inboundMessageService = require('./services/inbound-message.service');
const realtime = require('./lib/realtime');

const outbound = new Worker('outbound-messages', async (job) => {

  const result = await db.query(`SELECT m.id, m.type, m.body, m.media_id, m.filename, m.organization_id, m.conversation_id, c.phone_number FROM messages m JOIN conversations cv ON cv.id = m.conversation_id JOIN contacts c ON c.id = cv.contact_id WHERE m.id = $1 AND m.status = 'pending'`, [job.data.messageId]);
  const message = result.rows[0];

  if (!message) return;
  try {
    const sent = message.type === 'document'
      ? await messageService.sendAttachment({ to: message.phone_number, type: 'document', id: message.media_id, filename: message.filename || undefined, caption: message.body || undefined })
      : message.type === 'image'
        ? await messageService.sendAttachment({ to: message.phone_number, type: 'image', id: message.media_id, caption: message.body || undefined })
        : message.type === 'audio'
          ? await messageService.sendAttachment({ to: message.phone_number, type: 'audio', id: message.media_id })
        : await messageService.sendText({ to: message.phone_number, body: message.body });

    await db.query("UPDATE messages SET status = 'sent', provider_message_id = $2, updated_at = now() WHERE id = $1", [message.id, sent.messages[0]?.id || null]);
    await realtime.publish(message.organization_id, 'message.sent', message.conversation_id);
  } catch (error) {
    await db.query("UPDATE messages SET status = 'failed', error_code = $2, updated_at = now() WHERE id = $1", [message.id, error.message]);
    await realtime.publish(message.organization_id, 'message.failed', message.conversation_id);
    throw error;
  }
}, { connection: connection(), concurrency: Number(process.env.WORKER_CONCURRENCY || 5) });

outbound.on('failed', (job, error) => console.error(JSON.stringify({ level: 'error', queue: 'outbound-messages', jobId: job?.id, errorType: error.name })));



const inbound = new Worker('inbound-webhooks', async (job) => {

  console.log(JSON.stringify({ level: 'info', message: 'Processing inbound webhook', jobId: job.id }));

  await inboundMessageService.process(job.data.payload);

  console.log(JSON.stringify({ level: 'info', message: 'Inbound webhook processed', jobId: job.id }));

}, { connection: connection(), concurrency: Number(process.env.WORKER_CONCURRENCY || 5) });


inbound.on('failed', (job, error) => console.error(JSON.stringify({ level: 'error', queue: 'inbound-webhooks', jobId: job?.id, errorType: error.name })));
console.log(JSON.stringify({ level: 'info', message: 'Worker listening for outbound messages' }));
