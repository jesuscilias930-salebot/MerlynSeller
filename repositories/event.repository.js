// This cache prevents duplicate work during retries in one process. Replace it
// with Redis/Postgres before adding side effects or running multiple containers.
const processedEvents = new Map();
const DEDUPLICATION_TTL_MS = Number(process.env.WEBHOOK_DEDUPLICATION_TTL_MS || 24 * 60 * 60 * 1000);

const countChanges = (event) => event?.entry?.reduce((count, entry) => (
  count + (entry?.changes?.length || 0)
), 0) || 0;

const pruneExpiredEvents = (now) => {
  for (const [key, expiresAt] of processedEvents) {
    if (expiresAt <= now) processedEvents.delete(key);
  }
};

exports.save = async (event, eventKey) => {
  const now = Date.now();
  pruneExpiredEvents(now);
  if (processedEvents.has(eventKey)) {
    console.log(JSON.stringify({ level: 'info', message: 'Duplicate webhook ignored' }));
    return { duplicate: true };
  }

  processedEvents.set(eventKey, now + DEDUPLICATION_TTL_MS);
  // Never log payloads: WhatsApp events can contain message content and PII.
  console.log(JSON.stringify({
    level: 'info',
    message: 'Webhook accepted',
    object: event?.object || 'unknown',
    entries: event?.entry?.length || 0,
    changes: countChanges(event),
  }));
  return { duplicate: false };
};
