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

exports.isValidSignature = (rawBody, signatureHeader) => {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret || !Buffer.isBuffer(rawBody) || typeof signatureHeader !== 'string') return false;

  const match = /^sha256=([a-f0-9]{64})$/i.exec(signatureHeader);
  if (!match) return false;

  const expectedSignature = crypto
    .createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex');
  return safeEqual(match[1].toLowerCase(), expectedSignature);
};

exports.processEvent = async (body, rawBody) => {
  const eventKey = crypto.createHash('sha256').update(rawBody).digest('hex');
  return eventRepository.save(body, eventKey);
};
