const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const leads = require('../services/lead.service');

const COL = '11111111-1111-4111-8111-111111111111';
const EMPTY = '22222222-2222-4222-8222-222222222222';

test('tablero: 20 por columna por defecto, total real y filtro en el servidor', async () => {
  const original = db.query; const calls = []; const children = []; const childRows = [];
  db.query = async (sql, args) => {
    calls.push({ sql, args });
    if (sql.includes('parent_board_id = $2')) return { rows: children };
    if (sql.includes('FROM lead_boards')) return { rows: [{ id: 'b1' }] };
    if (sql.includes('FROM lead_columns WHERE organization_id')) return { rows: [{ id: COL, name: 'R1' }, { id: EMPTY, name: 'R2' }] };
    if (sql.includes('WITH groups')) return { rows: [{ id: 'l1', lead_column_id: COL, total: 45, group_key: COL }, ...childRows] };
    if (sql.includes('GROUP BY c.lead_column_id')) return { rows: [] };
    return { rows: [] };
  };
  try {
    const columns = await leads.board('org', 'user', 'b1', { filter: 'unread' });
    assert.deepEqual(columns.map((c) => [c.name, c.leads.map((l) => l.id), c.leadCount]), [['R1', ['l1'], 45], ['R2', [], 0]]);
    assert.ok(!('total' in columns[0].leads[0]), 'el total no viaja en cada lead');
    const page = calls.find((call) => call.sql.includes('WITH groups'));
    assert.deepEqual(page.args.slice(3, 5), [0, 20]);
    assert.match(page.sql, /> 0\n/, 'filtro de no leídos aplicado en SQL');
    await leads.board('org', 'user', 'b1', { limit: '5000' });
    assert.equal(calls.filter((call) => call.sql.includes('WITH groups')).at(-1).args[4], 200, 'máximo 200 por columna');
  } finally { db.query = original; }
});

test('siguiente página de una columna', async () => {
  const original = db.query;
  db.query = async (sql, args) => {
    if (sql.includes('FROM lead_columns WHERE id')) return { rows: args[0] === COL ? [{ id: COL }] : [] };
    if (sql.includes('WITH groups')) return { rows: [{ id: 'l21', lead_column_id: COL, total: 25, group_key: COL }] };
    return { rows: [] };
  };
  try {
    assert.deepEqual(await leads.columnPage('org', 'user', COL, { offset: '20' }), { leads: [{ id: 'l21', lead_column_id: COL }], leadCount: 25 });
    await assert.rejects(leads.columnPage('org', 'user', 'nope'), (error) => error.status === 404);
  } finally { db.query = original; }
});

const CHILD = '33333333-3333-4333-8333-333333333333';
test('dashboard padre: una columna virtual por hijo con todos sus leads, paginada', async () => {
  const original = db.query; const calls = [];
  db.query = async (sql, args) => {
    calls.push({ sql, args });
    if (sql.includes('parent_board_id = $2')) return { rows: [{ id: CHILD, name: 'Campaña 120', columnIds: ['x1', 'x2'] }] };
    if (sql.includes('FROM lead_boards')) return { rows: [{ id: 'padre' }] };
    if (sql.includes('FROM lead_columns WHERE organization_id')) return { rows: [{ id: COL, name: 'Primer contacto' }] };
    if (sql.includes('WITH groups')) return { rows: [{ id: 'l1', lead_column_id: COL, total: 1, group_key: COL }, { id: 'l2', lead_column_id: 'x2', total: 30, group_key: `board:${CHILD}` }] };
    return { rows: [] };
  };
  try {
    const columns = await leads.board('org', 'user', 'padre');
    assert.deepEqual(columns.map((c) => [c.id, c.name, c.virtual || false, c.leadCount, c.leads.map((l) => l.lead_column_id)]), [
      [COL, 'Primer contacto', false, 1, [COL]],
      [`board:${CHILD}`, 'Campaña 120', true, 30, ['x2']],
    ]);
    assert.equal(columns[1].childBoardId, CHILD);
    const query = calls.find((call) => call.sql.includes('WITH groups'));
    assert.deepEqual(query.args[2], [COL, 'x1', 'x2']);
    assert.deepEqual(query.args[5], [COL, `board:${CHILD}`, `board:${CHILD}`]);
  } finally { db.query = original; }
});

test('página siguiente de la columna de un hijo', async () => {
  const original = db.query; const calls = [];
  db.query = async (sql, args) => {
    calls.push({ sql, args });
    if (sql.includes('array_agg(column_row.id)')) return { rows: [{ columnIds: args[0] === CHILD ? ['x1'] : [null], found: args[0] === CHILD ? 1 : 0 }] };
    if (sql.includes('WITH groups')) return { rows: [{ id: 'l21', lead_column_id: 'x1', total: 21, group_key: `board:${CHILD}` }] };
    return { rows: [] };
  };
  try {
    assert.deepEqual(await leads.columnPage('org', 'user', `board:${CHILD}`, { offset: 20 }), { leads: [{ id: 'l21', lead_column_id: 'x1' }], leadCount: 21 });
    await assert.rejects(leads.columnPage('org', 'user', `board:${COL}`), (error) => error.status === 404);
  } finally { db.query = original; }
});
