const crypto = require('node:crypto');
const eventRepository = require('../repositories/event.repository');

const safeEqual = (received, expected) => {
  if (typeof received !== 'string' || typeof expected !== 'string') return false;
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
};

exports.isValidToken = (mode, token) => (
  mode === 'subscribe' && safeEqual(token, process.env.VERIFY_TOKEN)
);

exports.isValidSignature = (rawBody, signatureHeaderMeta) => {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret || !Buffer.isBuffer(rawBody) || typeof signatureHeaderMeta !== 'string') return false;

  const match = /^sha256=([a-f0-9]{64})$/i.exec(signatureHeaderMeta);
  if (!match) return false;

  const expectedSignature = crypto
    .createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex');
  return safeEqual(match[1].toLowerCase(), expectedSignature);
};

const countBy = (items, key) => items.reduce((counts, item) => {
  const value = item?.[key] || 'unknown';
  counts[value] = (counts[value] || 0) + 1;
  return counts;
}, {});

// This summary is intentionally metadata-only. Do not add message body,
// contact name, phone number, access tokens, or complete payloads to logs.
exports.summarizeEvent = (body) => {
  const changes = (body?.entry || []).flatMap((entry) => entry?.changes || []);
  const values = changes.map((change) => change?.value || {});
  const messages = values.flatMap((value) => value.messages || []);
  const statuses = values.flatMap((value) => value.statuses || []);
  return {
    object: body?.object || 'unknown',
    entries: body?.entry?.length || 0,
    changes: changes.length,
    incomingMessages: messages.length,
    messageTypes: countBy(messages, 'type'),
    statusUpdates: statuses.length,
    statuses: countBy(statuses, 'status'),
  };
};

exports.processEvent = async (body, rawBody) => {
  const eventKey = crypto.createHash('sha256').update(rawBody).digest('hex');
  return eventRepository.save(body, eventKey);
};
