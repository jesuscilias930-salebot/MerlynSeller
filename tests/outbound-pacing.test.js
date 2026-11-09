const test = require('node:test');
const assert = require('node:assert/strict');
const pacing = require('../lib/outbound-pacing');

const fakeClock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; } }; };

test('tras un video espera la entrega antes del siguiente mensaje', async () => {
  const clock = fakeClock();
  const statuses = ['sent', 'sent', 'sent', 'delivered'];
  const db = { query: async () => ({ rows: [{ status: statuses.shift() || 'delivered' }] }) };
  const result = await pacing.waitForDelivery({ db, messageId: 'm', type: 'video', hasNext: async () => true, keepAlive: async () => true, ...clock });
  assert.deepEqual(result, { waited: 3000, reason: 'delivered' });
});

test('no espera si no hay nada detrás, si es texto, y se rinde al tiempo máximo', async () => {
  const db = { query: async () => ({ rows: [{ status: 'sent' }] }) };
  assert.equal((await pacing.waitForDelivery({ db, messageId: 'm', type: 'video', hasNext: async () => false })).reason, 'nothing_after');
  assert.equal((await pacing.waitForDelivery({ db, messageId: 'm', type: 'text', hasNext: async () => true })).reason, 'not_media');
  const clock = fakeClock();
  const timeout = await pacing.waitForDelivery({ db, messageId: 'm', type: 'image', hasNext: async () => true, keepAlive: async () => true, ...clock });
  assert.equal(timeout.reason, 'timeout');
  assert.equal(timeout.waited, pacing.maxWaitFor('image'));
  const lost = await pacing.waitForDelivery({ db, messageId: 'm', type: 'video', hasNext: async () => true, keepAlive: async () => false, ...fakeClock() });
  assert.equal(lost.reason, 'lock_lost');
});
