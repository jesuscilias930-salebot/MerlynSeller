const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const locations = require('../services/product-location.service');

const withDb = async (handler, run) => { const original = db.query; db.query = handler; try { return await run(); } finally { db.query = original; } };

test('guarda rack, piso y lado para uno o varios productos', async () => {
  let call;
  const rows = await withDb(async (sql, args) => { call = { sql, args }; return { rows: args[1].map((productId) => ({ productId, rack: args[2], level: args[3], side: args[4] })) }; },
    () => locations.save('org', { productIds: [12, 13, 12], rack: '  A  ', level: '2', side: 'Izquierdo  ' }));
  assert.match(call.sql, /ON CONFLICT \(organization_id, product_id\) DO UPDATE/);
  assert.deepEqual(call.args, ['org', [12, 13], 'A', '2', 'Izquierdo']);
  assert.equal(rows.length, 2);
});

test('una ubicación vacía se borra', async () => {
  let call;
  await withDb(async (sql, args) => { call = { sql, args }; return { rows: [] }; }, () => locations.save('org', { productIds: [5], rack: ' ', level: null, side: '' }));
  assert.match(call.sql, /^DELETE FROM product_locations/);
  assert.deepEqual(call.args, ['org', [5]]);
});

test('valida datos', async () => {
  await assert.rejects(locations.save('org', { productIds: [], rack: 'A' }), { status: 400, message: 'Selecciona al menos un producto' });
  await assert.rejects(locations.save('org', { productIds: [1], rack: 'x'.repeat(31) }), { message: 'El rack admite máximo 30 caracteres' });
  await assert.rejects(locations.save('org', { productIds: [0], rack: 'A' }), { status: 400 });
});
