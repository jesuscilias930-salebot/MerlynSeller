const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const realtime = require('../lib/realtime');
const leads = require('../services/lead.service');

const columnId = '11111111-1111-4111-8111-111111111111';
const replacementId = '22222222-2222-4222-8222-222222222222';

test('borrar una columna mueve sus leads y actualiza los escenarios que la usaban', async () => {
  const calls = [];
  const client = { query: async (sql, args) => {
    calls.push({ sql, args });
    if (sql.startsWith('SELECT id, name, board_id FROM lead_columns')) return { rows: [{ id: columnId, name: 'Seguimiento', board_id: 'board1' }] };
    if (sql.startsWith('SELECT id FROM lead_columns')) return { rows: [{ id: replacementId }] };
    if (sql.startsWith('UPDATE conversations')) return { rowCount: 3, rows: [] };
    if (sql.startsWith('UPDATE column_rules')) return { rowCount: 1, rows: [] };
    if (sql.startsWith('SELECT id, steps FROM automation_scenarios')) return { rows: [{ id: 's1', steps: [{ id: 'a', type: 'move_column', columnId }, { id: 'b', type: 'end' }] }] };
    return { rows: [] };
  } };
  const original = { transaction: db.transaction, publish: realtime.publish };
  db.transaction = (fn) => fn(client);
  realtime.publish = async () => {};
  try {
    const result = await leads.removeColumn('org', columnId);
    assert.deepEqual(result, { deletedId: columnId, movedLeads: 3, replacementId });
    const scenarioUpdate = calls.find((call) => call.sql.startsWith('UPDATE automation_scenarios'));
    assert.deepEqual(JSON.parse(scenarioUpdate.args[2])[0], { id: 'a', type: 'move_column', columnId: replacementId });
    assert.ok(calls.at(-1).sql.startsWith('DELETE FROM lead_columns'));
    const replacement = calls.find((call) => call.sql.startsWith('SELECT id FROM lead_columns'));
    assert.deepEqual(replacement.args, ['org', columnId, 'board1'], 'el reemplazo es del mismo dashboard');
    assert.ok(calls.some((call) => call.sql.startsWith('UPDATE column_rules') && call.args[0] === replacementId), 'las reglas de columna pasan al reemplazo');
  } finally { db.transaction = original.transaction; realtime.publish = original.publish; }
});
