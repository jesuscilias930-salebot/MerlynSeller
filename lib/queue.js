const { Queue } = require('bullmq');
const IORedis = require('ioredis');

let connection;
const getConnection = () => {
  if (!process.env.REDIS_URL) throw new Error('REDIS_URL is not configured');
  if (!connection) connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  return connection;
};

const defaultOptions = { attempts: 5, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 1000, removeOnFail: 1000 };
exports.connection = getConnection;
exports.outboundQueue = () => new Queue('outbound-messages', { connection: getConnection(), defaultJobOptions: defaultOptions });
exports.inboundQueue = () => new Queue('inbound-webhooks', { connection: getConnection(), defaultJobOptions: defaultOptions });
