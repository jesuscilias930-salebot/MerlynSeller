const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const realtime = require('../lib/realtime');
const timeouts = require('../services/column-timeout.service');

const COL = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';

test('guardar: valida espera y columna destino', async () => {
  const original = db.query;
  db.query = async (sql, args) => {
    if (sql.includes('FROM lead_columns')) return { rows: args[1].map((id) => ({ id })) };
    if (sql.includes('INSERT INTO column_timeouts')) return { rows: [{ columnId: args[1], targetColumnId: args[2], waitMinutes: args[3], isActive: args[4] }] };
    return { rows: [] };
  };
  try {
    assert.deepEqual(await timeouts.save('org', COL, { waitMinutes: 4320, targetColumnId: TARGET }), { columnId: COL, targetColumnId: TARGET, waitMinutes: 4320, isActive: true });
    await assert.rejects(timeouts.save('org', COL, { waitMinutes: 10, targetColumnId: TARGET }), /mínima/);
    await assert.rejects(timeouts.save('org', COL, { waitMinutes: 60, targetColumnId: COL }), /distinta/);
    await assert.rejects(timeouts.save('org', COL, { waitMinutes: 60 }), /columna/);
  } finally { db.query = original; }
});

test('run: mueve solo si sigue en la columna y avisa al tablero', async () => {
  const original = { query: db.query, publish: realtime.publish };
  const published = [];
  realtime.publish = async (org, event, id) => { published.push([event, id]); };
  db.query = async (sql, args) => {
    if (sql.includes('FROM column_timeouts t')) return { rows: [
      { conversation_id: 'c1', organization_id: 'org', column_id: COL, target_column_id: TARGET },
      { conversation_id: 'c2', organization_id: 'org', column_id: COL, target_column_id: TARGET },
    ] };
    if (sql.includes('UPDATE conversations')) return { rows: args[0] === 'c1' ? [{ id: 'c1' }] : [] };
    return { rows: [] };
  };
  try {
    assert.deepEqual(await timeouts.run(), { moved: 1 });
    assert.deepEqual(published, [['lead.moved', 'c1']]);
  } finally { db.query = original.query; realtime.publish = original.publish; }
});
