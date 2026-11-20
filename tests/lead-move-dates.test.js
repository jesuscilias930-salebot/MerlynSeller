const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const realtime = require('../lib/realtime');
const leads = require('../services/lead.service');

const SOURCE = '11111111-1111-4111-8111-111111111111', TARGET = '22222222-2222-4222-8222-222222222222';
const run = async (body) => {
  const original = { transaction: db.transaction, query: db.query, publish: realtime.publish };
  let update;
  db.query = async (sql) => sql.includes('business_hours_settings') ? { rows: [{ config: { timezone: 'America/Tijuana' } }] } : { rows: [] };
  db.transaction = async (fn) => fn({ query: async (sql, args) => {
    if (sql.includes('FROM lead_columns')) return { rowCount: 2, rows: [] };
    update = { sql, args }; return { rowCount: 3 };
  } });
  realtime.publish = async () => {};
  try { return { result: await leads.moveAllFromColumn('org', SOURCE, body), update }; }
  finally { Object.assign(db, { transaction: original.transaction, query: original.query }); realtime.publish = original.publish; }
};

test('sin fechas mueve todos los leads de la columna', async () => {
  const { result, update } = await run({ targetColumnId: TARGET });
  assert.equal(result.movedLeads, 3);
  assert.deepEqual(update.args.slice(3), [null, null, 'America/Mexico_City']);
});

test('con fechas filtra por el último mensaje en la zona horaria del negocio', async () => {
  const { result, update } = await run({ targetColumnId: TARGET, from: '2026-11-01', to: '2026-11-15' });
  assert.deepEqual(update.args.slice(3), ['2026-11-01', '2026-11-15', 'America/Tijuana']);
  assert.match(update.sql, /AT TIME ZONE \$6/);
  assert.equal(result.from, '2026-11-01');
  assert.deepEqual((await run({ targetColumnId: TARGET, from: '2026-11-10' })).update.args.slice(3, 5), ['2026-11-10', null]);
});

test('rechaza fechas inválidas o invertidas', async () => {
  await assert.rejects(run({ targetColumnId: TARGET, from: '20-11-2026' }), { status: 400 });
  await assert.rejects(run({ targetColumnId: TARGET, from: '2026-11-20', to: '2026-11-01' }), /posterior/);
});
