const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const realtime = require('../lib/realtime');
const boards = require('../services/lead-board.service');
const leads = require('../services/lead.service');

const boardId = '33333333-3333-4333-8333-333333333333';
const withDb = async (handler, fn) => {
  const original = { query: db.query, transaction: db.transaction, publish: realtime.publish };
  const calls = [];
  const query = async (sql, args) => { calls.push({ sql, args }); return handler(sql, args) || { rows: [] }; };
  db.query = query; db.transaction = (work) => work({ query }); realtime.publish = async () => {};
  try { await fn(calls); } finally { Object.assign(db, { query: original.query, transaction: original.transaction }); realtime.publish = original.publish; }
};

test('crear un dashboard le pone solo la columna «Primer contacto»', async () => {
  await withDb((sql) => {
    if (sql.includes('INSERT INTO lead_boards')) return { rows: [{ id: boardId, name: 'Calcetas · Orizaba', product: 'Calcetas', zone: 'Orizaba', isDefault: false }] };
    if (sql.includes('INSERT INTO lead_columns')) return { rows: [{ id: 'a' }, { id: 'b' }], rowCount: 2 };
    return null;
  }, async (calls) => {
    const board = await boards.create('org', { name: ' Calcetas · Orizaba ', product: 'Calcetas', zone: 'Orizaba' });
    assert.equal(board.id, boardId);
    const insert = calls.find((call) => call.sql.includes('INSERT INTO lead_boards'));
    assert.deepEqual(insert.args, ['org', 'Calcetas · Orizaba', 'Calcetas', 'Orizaba']);
    const columns = calls.filter((call) => call.sql.includes('INSERT INTO lead_columns'));
    assert.equal(columns.length, 1);
    assert.match(columns[0].sql, /'Primer contacto', 0/);
    assert.deepEqual(columns[0].args, ['org', boardId]);
    await assert.rejects(boards.create('org', { name: '  ' }), { status: 400 });
  });
});

test('borrar un dashboard pasa sus leads a la columna del mismo nombre en el principal', async () => {
  await withDb((sql) => {
    if (sql.startsWith('SELECT id, is_default FROM lead_boards')) return { rows: [{ id: boardId, is_default: false }] };
    if (sql.includes('column_row.board_id = $2 AS own')) return { rows: [
      { id: 'p1', name: 'Primer contacto', own: false }, { id: 'p2', name: 'R-HOT', own: false },
      { id: 'o1', name: 'Primer contacto', own: true }, { id: 'o2', name: 'R HOT', own: true }, { id: 'o3', name: 'Solo aquí', own: true },
    ] };
    if (sql.startsWith('UPDATE conversations')) return { rowCount: 2, rows: [] };
    return null;
  }, async (calls) => {
    const result = await boards.remove('org', boardId);
    assert.deepEqual(result, { deletedId: boardId, movedLeads: 6 });
    const moves = calls.filter((call) => call.sql.startsWith('UPDATE conversations')).map((call) => [call.args[2], call.args[0]]);
    assert.deepEqual(moves, [['o1', 'p1'], ['o2', 'p2'], ['o3', 'p1']]);
    assert.ok(calls.at(-1).sql.startsWith('DELETE FROM lead_boards'));
  });
  await withDb((sql) => (sql.startsWith('SELECT id, is_default') ? { rows: [{ id: boardId, is_default: true }] } : null), async () => {
    await assert.rejects(boards.remove('org', boardId), { status: 409, message: 'El dashboard principal no se puede eliminar' });
  });
});

test('el tablero carga solo los leads del dashboard abierto', async () => {
  await withDb((sql) => {
    if (sql.includes('FROM lead_boards')) return { rows: [{ id: boardId }] };
    if (sql.includes('FROM lead_columns WHERE')) return { rows: [{ id: 'c1', name: 'Nuevos', position: 0, boardId }] };
    if (sql.includes('FROM conversations c')) return { rows: [{ id: 'conv1', lead_column_id: 'c1' }] };
    return null;
  }, async (calls) => {
    const columns = await leads.board('org', 'user', boardId);
    assert.equal(columns[0].leads.length, 1);
    const leadsQuery = calls.find((call) => call.sql.includes('FROM conversations c'));
    assert.deepEqual(leadsQuery.args, ['org', 'user', ['c1']]);
  });
});

test('Requiere atención se busca primero en el dashboard del chat', async () => {
  await withDb((sql) => {
    if (sql.includes('current_column.board_id')) return { rows: [{ id: 'own-attention', name: 'Requiere atención' }, { id: 'main-attention', name: 'Requiere atencion' }] };
    if (sql.startsWith('UPDATE conversations')) return { rows: [{ id: 'conv' }] };
    return null;
  }, async (calls) => {
    assert.equal(await leads.moveToAttention('org', 'conv'), true);
    assert.equal(calls.find((call) => call.sql.startsWith('UPDATE conversations')).args[2], 'own-attention');
  });
});
