const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const realtime = require('../lib/realtime');
const boards = require('../services/lead-board.service');

const SOURCE = '11111111-1111-4111-8111-111111111111';
const COLUMN = '22222222-2222-4222-8222-222222222222';
const OTHER_BOARD = '33333333-3333-4333-8333-333333333333';

const withClient = async (handler, fn) => {
  const original = { transaction: db.transaction, publish: realtime.publish };
  const calls = [];
  let next = 0;
  const client = { query: async (sql, args) => { calls.push({ sql, args }); const rows = handler(sql, args); if (rows) return rows; if (sql.includes('INSERT INTO lead_columns')) return { rows: [{ id: `new-${next++}` }] }; return { rows: [] }; } };
  db.transaction = async (callback) => callback(client);
  realtime.publish = async () => {};
  try { await fn(calls); } finally { Object.assign(db, { transaction: original.transaction }); realtime.publish = original.publish; }
};
const boardRow = (sql) => sql.includes('INSERT INTO lead_boards') ? { rows: [{ id: 'board-new', name: 'Campaña 120' }] } : null;

test('vacío: solo «Primer contacto»', async () => {
  await withClient(boardRow, async (calls) => {
    const board = await boards.create('org', { name: 'Campaña 120' });
    assert.deepEqual(board.copied, { columns: 1, timeouts: 0, followUps: 0 });
    assert.ok(calls.some((call) => call.sql.includes("'Primer contacto'")));
  });
});

test('plantilla de campaña: 8 columnas y 3 ⏳ en pausa encadenados', async () => {
  await withClient(boardRow, async (calls) => {
    const board = await boards.create('org', { name: 'Campaña 120', source: { type: 'template', template: 'campaign' } });
    assert.deepEqual(board.copied, { columns: 8, timeouts: 3, followUps: 0 });
    const names = calls.filter((call) => call.sql.startsWith('INSERT INTO lead_columns')).map((call) => call.args[2]);
    assert.deepEqual(names, ['Cotización', 'Remarketing 1', 'Remarketing 2', 'Remarketing 3', 'Dudas', 'Cierre', 'Pedido', 'Perdido']);
    const timeouts = calls.filter((call) => call.sql.includes('INSERT INTO column_timeouts'));
    assert.ok(timeouts.every((call) => call.sql.includes('false')), 'en pausa');
    assert.deepEqual(timeouts.map((call) => [call.args[1], call.args[2], call.args[3]]), [['new-1', 'new-2', 4320], ['new-2', 'new-3', 5760], ['new-3', 'new-7', 10080]]);
  });
});

test('copiar: columnas, ⏳ y ⏱ en pausa con destinos reapuntados al nuevo dashboard', async () => {
  await withClient((sql) => boardRow(sql)
    || (sql.includes('SELECT id, name, position FROM lead_columns') ? { rows: [{ id: 'a', name: 'R1' }, { id: 'b', name: 'R2' }] } : null)
    || (sql.includes('FROM column_timeouts') ? { rows: [{ column_id: 'a', target_column_id: 'b', wait_minutes: 4320 }, { column_id: 'b', target_column_id: 'fuera', wait_minutes: 60 }] } : null)
    || (sql.includes('FROM follow_up_sequences') ? { rows: [{ column_id: 'a', steps: [{ waitMinutes: 60, text: 'Hola' }], final_column_id: 'b' }] } : null), async (calls) => {
    const board = await boards.create('org', { name: 'Campaña 200', source: { type: 'clone', boardId: SOURCE } });
    assert.deepEqual(board.copied, { columns: 2, timeouts: 2, followUps: 1 });
    const timeouts = calls.filter((call) => call.sql.includes('INSERT INTO column_timeouts')).map((call) => call.args.slice(1, 3));
    assert.deepEqual(timeouts, [['new-0', 'new-1'], ['new-1', 'fuera']], 'dentro se reapunta; fuera se conserva');
    const followUp = calls.find((call) => call.sql.includes('INSERT INTO follow_up_sequences'));
    assert.deepEqual([followUp.args[1], followUp.args[3]], ['new-0', 'new-1']);
    assert.ok(!calls.some((call) => /UPDATE conversations|INSERT INTO conversations/.test(call.sql)), 'no copia leads');
  });
  await assert.rejects(boards.create('org', { name: 'X', source: { type: 'clone' } }), /copiar/);
});

test('mover columna: va al final del otro dashboard, con validaciones', async () => {
  const handler = (remaining, conflict = false) => (sql) => {
    if (sql.includes('FOR UPDATE')) return { rows: [{ id: COLUMN, name: 'Cierre 120', board_id: SOURCE }] };
    if (sql.includes('FROM lead_boards')) return { rows: [{ id: OTHER_BOARD, name: 'Campaña 120' }] };
    if (sql.includes('count(*)')) return { rows: [{ total: remaining }] };
    if (sql.startsWith('UPDATE lead_columns')) { if (conflict) throw Object.assign(new Error('dup'), { code: '23505' }); return { rows: [{ id: COLUMN, name: 'Cierre 120', boardId: OTHER_BOARD, position: 5 }] }; }
    return null;
  };
  await withClient(handler(3), async () => {
    assert.deepEqual(await boards.moveColumn('org', COLUMN, { boardId: OTHER_BOARD }), { id: COLUMN, name: 'Cierre 120', boardId: OTHER_BOARD, position: 5, boardName: 'Campaña 120' });
  });
  await withClient(handler(0), async () => {
    await assert.rejects(boards.moveColumn('org', COLUMN, { boardId: OTHER_BOARD }), /al menos una columna/);
  });
  await withClient(handler(3, true), async () => {
    await assert.rejects(boards.moveColumn('org', COLUMN, { boardId: OTHER_BOARD }), /Renómbrala/);
  });
  await assert.rejects(boards.moveColumn('org', COLUMN, {}), /destino/);
});
