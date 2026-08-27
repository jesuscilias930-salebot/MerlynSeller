const IORedis = require('ioredis');

const CHANNEL = 'merlynsales:realtime';
const clients = new Map();
let publisher;
let subscriber;

const redisOptions = { maxRetriesPerRequest: null };
const ensureRedis = () => {
  if (!process.env.REDIS_URL) throw new Error('REDIS_URL is not configured');
  if (!publisher) publisher = new IORedis(process.env.REDIS_URL, redisOptions);
  return publisher;
};

const deliver = (event) => {
  for (const response of clients.get(event.organizationId) || []) {
    response.write(`event: conversation.updated\ndata: ${JSON.stringify(event)}\n\n`);
  }
};

exports.start = () => {
  if (subscriber || !process.env.REDIS_URL) return;
  subscriber = new IORedis(process.env.REDIS_URL, redisOptions);
  subscriber.subscribe(CHANNEL);
  subscriber.on('message', (channel, payload) => {
    if (channel !== CHANNEL) return;
    try { deliver(JSON.parse(payload)); } catch { /* Ignore invalid external events. */ }
  });
};

exports.publish = async (organizationId, type, conversationId) => {
  await ensureRedis().publish(CHANNEL, JSON.stringify({ organizationId, type, conversationId }));
};

exports.connect = (organizationId, response) => {
  const group = clients.get(organizationId) || new Set();
  group.add(response);
  clients.set(organizationId, group);
  return () => {
    group.delete(response);
    if (group.size === 0) clients.delete(organizationId);
  };
};
