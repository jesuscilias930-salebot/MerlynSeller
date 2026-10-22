const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const slots = require('../services/product-location-slot.service');

const withDb = async (run) => {
  const calls = [];
  const client = { query: async (sql, args) => { calls.push({ sql, args }); return { rows: sql.startsWith('INSERT') ? [{ productId: args[1], size: args[2], color: args[3], quantity: args[4], rack: args[5], level: args[6], side: args[7] }] : [] }; } };
  const original = db.transaction;
  db.transaction = (callback) => callback(client);
  try { return { result: await run(), calls }; } finally { db.transaction = original; }
};

test('reemplaza las ubicaciones por talla y color del producto', async () => {
  const { result, calls } = await withDb(() => slots.replace('org', '12', { slots: [
    { size: ' 25-28 ', color: 'Negro', quantity: 40, rack: 'A', level: '2', side: 'Izquierdo' },
    { size: '22-25', rack: 'B' },
  ] }));
  assert.match(calls[0].sql, /^DELETE FROM product_location_slots/);
  assert.equal(calls.length, 3);
  assert.deepEqual(result[0], { productId: 12, size: '25-28', color: 'Negro', quantity: 40, rack: 'A', level: '2', side: 'Izquierdo' });
  assert.deepEqual(calls[2].args.slice(2), ['22-25', null, null, 'B', null, null, 1]);
});

test('una lista vacía borra las ubicaciones del producto', async () => {
  const { result, calls } = await withDb(() => slots.replace('org', 12, { slots: [] }));
  assert.deepEqual(result, []);
  assert.equal(calls.length, 1);
});

test('valida filas', async () => {
  await assert.rejects(slots.replace('org', 'x', { slots: [] }), { message: 'Producto inválido' });
  await assert.rejects(slots.replace('org', 1, {}), { message: 'Indica la lista de ubicaciones' });
  await assert.rejects(slots.replace('org', 1, { slots: [{ rack: 'A' }] }), { message: 'Fila 1: indica la talla o el color' });
  await assert.rejects(slots.replace('org', 1, { slots: [{ size: '25-28' }] }), { message: 'Fila 1: indica rack, piso o lado' });
  await assert.rejects(slots.replace('org', 1, { slots: [{ size: '25-28', rack: 'A' }, { size: '25-28 ', rack: 'B' }] }), { message: 'Fila 2: esa talla y color ya están en otra fila' });
  await assert.rejects(slots.replace('org', 1, { slots: [{ size: '25-28', rack: 'A', quantity: -1 }] }), { status: 400 });
});
