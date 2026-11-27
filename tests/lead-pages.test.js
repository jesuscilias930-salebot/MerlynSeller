const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const leads = require('../services/lead.service');

const COL = '11111111-1111-4111-8111-111111111111';
const EMPTY = '22222222-2222-4222-8222-222222222222';

test('tablero: 20 por columna por defecto, total real y filtro en el servidor', async () => {
  const original = db.query; const calls = [];
  db.query = async (sql, args) => {
    calls.push({ sql, args });
    if (sql.includes('FROM lead_boards')) return { rows: [{ id: 'b1' }] };
    if (sql.includes('FROM lead_columns WHERE organization_id')) return { rows: [{ id: COL, name: 'R1' }, { id: EMPTY, name: 'R2' }] };
    if (sql.includes('WITH ranked')) return { rows: [{ id: 'l1', lead_column_id: COL, total: 45 }] };
    if (sql.includes('GROUP BY c.lead_column_id')) return { rows: [] };
    return { rows: [] };
  };
  try {
    const columns = await leads.board('org', 'user', 'b1', { filter: 'unread' });
    assert.deepEqual(columns.map((c) => [c.name, c.leads.map((l) => l.id), c.leadCount]), [['R1', ['l1'], 45], ['R2', [], 0]]);
    assert.ok(!('total' in columns[0].leads[0]), 'el total no viaja en cada lead');
    const page = calls.find((call) => call.sql.includes('WITH ranked'));
    assert.deepEqual(page.args.slice(3), [0, 20]);
    assert.match(page.sql, /> 0\n/, 'filtro de no leídos aplicado en SQL');
    await leads.board('org', 'user', 'b1', { limit: '5000' });
    assert.equal(calls.filter((call) => call.sql.includes('WITH ranked')).at(-1).args[4], 200, 'máximo 200 por columna');
  } finally { db.query = original; }
});

test('siguiente página de una columna', async () => {
  const original = db.query;
  db.query = async (sql, args) => {
    if (sql.includes('FROM lead_columns WHERE id')) return { rows: args[0] === COL ? [{ id: COL }] : [] };
    if (sql.includes('WITH ranked')) return { rows: [{ id: 'l21', lead_column_id: COL, total: 25 }] };
    return { rows: [] };
  };
  try {
    assert.deepEqual(await leads.columnPage('org', 'user', COL, { offset: '20' }), { leads: [{ id: 'l21', lead_column_id: COL }], leadCount: 25 });
    await assert.rejects(leads.columnPage('org', 'user', 'nope'), (error) => error.status === 404);
  } finally { db.query = original; }
});
