require('dotenv').config();
const { Worker } = require('bullmq');
const { connection, outboundQueue } = require('./lib/queue');
const db = require('./lib/db');
const messageService = require('./services/message.service');
const inboundMessageService = require('./services/inbound-message.service');
const realtime = require('./lib/realtime');

const OUTBOUND_LOCK_TTL_MS = 60_000;
const MAX_MESSAGES_PER_DRAIN = 100;
const outboundRedis = connection();

const pendingMessage = async (conversationId) => (await db.query(`
  SELECT m.id, m.type, m.body, m.media_id, m.filename, m.organization_id, m.conversation_id,
    m.outbound_sequence, c.phone_number,
    replied.provider_message_id AS reply_to_provider_message_id
  FROM messages m
  JOIN conversations cv ON cv.id = m.conversation_id
  JOIN contacts c ON c.id = cv.contact_id
  LEFT JOIN messages replied ON replied.id = m.reply_to_message_id
  WHERE m.conversation_id = $1
    AND m.direction = 'outbound'
    AND m.status = 'pending'
  ORDER BY m.outbound_sequence ASC NULLS LAST, m.created_at ASC, m.id ASC
  LIMIT 1
`, [conversationId])).rows[0];

const send = (message) => message.type === 'document'
  ? messageService.sendAttachment({ to: message.phone_number, type: 'document', id: message.media_id, filename: message.filename || undefined, caption: message.body || undefined })
  : message.type === 'image'
    ? messageService.sendAttachment({ to: message.phone_number, type: 'image', id: message.media_id, caption: message.body || undefined })
    : message.type === 'sticker'
      ? messageService.sendAttachment({ to: message.phone_number, type: 'sticker', id: message.media_id })
      : message.type === 'audio'
        ? messageService.sendAttachment({ to: message.phone_number, type: 'audio', id: message.media_id })
        : message.type === 'video'
          ? messageService.sendVideo({ to: message.phone_number, id: message.media_id })
          : messageService.sendText({ to: message.phone_number, body: message.body, replyToProviderMessageId: message.reply_to_provider_message_id || undefined });

const releaseLock = (key, token) => outboundRedis.eval(
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
  1,
  key,
  token,
);
const refreshLock = (key, token) => outboundRedis.eval(
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) end return 0",
  1,
  key,
  token,
  String(OUTBOUND_LOCK_TTL_MS),
);

const scheduleDrain = (conversationId) => outboundQueue().add(
  'drain-conversation',
  { conversationId },
  { jobId: `drain-${conversationId}-${Date.now()}` },
);

const drainConversation = async (conversationId, jobId) => {
  const lockKey = `outbound:conversation:${conversationId}`;
  const token = `${process.pid}:${jobId}:${Date.now()}`;
  const acquired = await outboundRedis.set(lockKey, token, 'PX', OUTBOUND_LOCK_TTL_MS, 'NX');
  if (!acquired) return;

  let processed = 0;
  let needsAnotherDrain = false;
  try {
    while (processed < MAX_MESSAGES_PER_DRAIN) {
      const message = await pendingMessage(conversationId);
      if (!message) return;
      if (!(await refreshLock(lockKey, token))) {
        needsAnotherDrain = true;
        return;
      }
      try {
        const sent = await send(message);
        await db.query("UPDATE messages SET status = 'sent', provider_message_id = $2, updated_at = now() WHERE id = $1", [message.id, sent.messages[0]?.id || null]);
        await realtime.publish(message.organization_id, 'message.sent', message.conversation_id);
        console.log(JSON.stringify({ level: 'info', message: 'Outbound message sent in FIFO order', conversationId, messageId: message.id, sequence: message.outbound_sequence }));
      } catch (error) {
        await db.query("UPDATE messages SET status = 'failed', error_code = $2, updated_at = now() WHERE id = $1", [message.id, error.message]);
        await realtime.publish(message.organization_id, 'message.failed', message.conversation_id);
        console.error(JSON.stringify({ level: 'error', message: 'Outbound message failed in FIFO drain', conversationId, messageId: message.id, sequence: message.outbound_sequence, errorType: error.name }));
      }
      processed += 1;
    }
    needsAnotherDrain = true;
  } finally {
    try {
      await releaseLock(lockKey, token);
    } finally {
      if (needsAnotherDrain) await scheduleDrain(conversationId);
    }
  }
};

const outbound = new Worker('outbound-messages', async (job) => {
  let conversationId = job.data.conversationId;
  if (!conversationId && job.data.messageId) {
    conversationId = (await db.query("SELECT conversation_id FROM messages WHERE id = $1 AND direction = 'outbound'", [job.data.messageId])).rows[0]?.conversation_id;
  }
  if (!conversationId) return;
  await drainConversation(conversationId, job.id);
}, { connection: connection(), concurrency: Number(process.env.WORKER_CONCURRENCY || 5) });

outbound.on('failed', (job, error) => console.error(JSON.stringify({ level: 'error', queue: 'outbound-messages', jobId: job?.id, errorType: error.name })));



const inbound = new Worker('inbound-webhooks', async (job) => {

  console.log(JSON.stringify({ level: 'info', message: 'Processing inbound webhook', jobId: job.id }));

  await inboundMessageService.process(job.data.payload);

  console.log(JSON.stringify({ level: 'info', message: 'Inbound webhook processed', jobId: job.id }));

}, { connection: connection(), concurrency: Number(process.env.WORKER_CONCURRENCY || 5) });


inbound.on('failed', (job, error) => console.error(JSON.stringify({ level: 'error', queue: 'inbound-webhooks', jobId: job?.id, errorType: error.name })));
console.log(JSON.stringify({ level: 'info', message: 'Worker listening for outbound messages' }));
