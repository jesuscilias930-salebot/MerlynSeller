const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const schedule = require('../services/remarketing-schedule.service');
const followUps = require('../services/follow-up.service');

const night = { isActive: true, pauseAt: '21:00', resumeAt: '09:00' };
const at = (h, m = 0) => h * 60 + m;

test('pausa que cruza la medianoche y pausa de día', () => {
  assert.equal(schedule.isQuietAt(night, at(22)), true);
  assert.equal(schedule.isQuietAt(night, at(3)), true);
  assert.equal(schedule.isQuietAt(night, at(9)), false, 'a las 9:00 ya reanuda');
  assert.equal(schedule.isQuietAt(night, at(20, 59)), false);
  const lunch = { isActive: true, pauseAt: '14:00', resumeAt: '16:00' };
  assert.equal(schedule.isQuietAt(lunch, at(15)), true);
  assert.equal(schedule.isQuietAt(lunch, at(17)), false);
  assert.equal(schedule.isQuietAt({ ...night, isActive: false }, at(23)), false);
});

test('estado: cuándo reanuda en la hora del negocio', () => {
  // 04:30 UTC = 22:30 en Ciudad de México → reanuda a las 07:30 locales = 13:30 UTC.
  const status = schedule.status({ ...night, pauseAt: '22:00', resumeAt: '07:30' }, 'America/Mexico_City', new Date('2026-11-27T04:30:00Z'));
  assert.equal(status.quiet, true);
  assert.equal(status.resumeAt.toISOString(), '2026-11-27T13:30:00.000Z');
  assert.deepEqual(schedule.status(night, 'America/Mexico_City', new Date('2026-11-27T18:00:00Z')), { quiet: false });
});

test('seguimientos ⏱ respetan el horario configurado', () => {
  const step = { waitMinutes: 60, text: 'Hola', imageIds: [] };
  const base = { step, lastOutAt: '2026-11-27T10:00:00Z', lastInAt: '2026-11-27T09:00:00Z', timezone: 'America/Mexico_City' };
  // 18:00 UTC = 12:00 local
  assert.equal(followUps.decide({ ...base, now: new Date('2026-11-27T18:00:00Z'), schedule: { isActive: true, pauseAt: '11:00', resumeAt: '13:00' } }).reason, 'quiet_hours');
  assert.equal(followUps.decide({ ...base, now: new Date('2026-11-27T18:00:00Z') }).action, 'send', 'sin configurar: 9 p. m. a 9 a. m.');
});

test('validación del horario', async () => {
  const original = db.query; db.query = async () => ({ rows: [] });
  try {
    assert.deepEqual(await schedule.save('org', { pauseAt: '21:30', resumeAt: '08:00' }), { isActive: true, pauseAt: '21:30', resumeAt: '08:00', deferCampaigns: true, configured: true });
    await assert.rejects(schedule.save('org', { pauseAt: '25:00', resumeAt: '08:00' }), /HH:MM/);
    await assert.rejects(schedule.save('org', { pauseAt: '08:00', resumeAt: '08:00' }), /distintas/);
    assert.deepEqual(await schedule.get('org'), { isActive: true, pauseAt: '21:00', resumeAt: '09:00', deferCampaigns: false, configured: false });
  } finally { db.query = original; }
});

test('al reanudar: cancela a quien escribió y libera el resto', async () => {
  const original = db.query; const sqls = [];
  const queue = require('../lib/queue'); const originalQueue = queue.outboundQueue; const jobs = [];
  queue.outboundQueue = () => ({ add: async (name, data, options) => jobs.push([name, data.messageId, options.jobId]) });
  const realtime = require('../lib/realtime'); const originalPublish = realtime.publish; realtime.publish = async () => {};
  db.query = async (sql) => {
    sqls.push(sql);
    if (sql.includes("error_code='cancelled_customer_replied'")) return { rowCount: 1, rows: [{ id: 'm0', organization_id: 'org' }] };
    if (sql.includes("SET status='pending'")) return { rowCount: 2, rows: [{ id: 'm1', type: 'template', organization_id: 'org' }, { id: 'm2', type: 'text', organization_id: 'org' }] };
    return { rows: [] };
  };
  try {
    assert.deepEqual(await schedule.release(), { released: 2, cancelled: 1 });
    assert.deepEqual(jobs, [['send-remarketing-template', 'm1', 'm1:released'], ['send-remarketing', 'm2', 'm2:released']]);
    assert.ok(sqls[0].includes('cancelled'), 'primero cancela, luego libera');
  } finally { db.query = original; queue.outboundQueue = originalQueue; realtime.publish = originalPublish; }
});
