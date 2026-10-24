const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const loans = require('../services/inventory-loan.service');

const id = '11111111-1111-4111-8111-111111111111';
const withDb = async (handlers, run) => {
  const original = { query: db.query, transaction: db.transaction };
  Object.assign(db, handlers);
  try { return await run(); } finally { Object.assign(db, original); }
};

test('registra una salida temporal con dónde, quién, regreso y nota', async () => {
  const calls = [];
  await withDb({ query: async (sql, args) => { calls.push({ sql, args }); return { rows: [{ id }] }; } },
    () => loans.create('org', 'not-a-uuid', { productId: 5, productName: 'Essential · Negro · Talla 25–28', quantity: 6, location: '  Tienda   Centro ', takenBy: 'Ana', returnDate: '2026-11-02', notes: '' }));
  assert.deepEqual(calls[0].args, ['org', 5, 6, 'Tienda Centro', 'Ana', '2026-11-02', null, null, 'Essential · Negro · Talla 25–28']);
});

test('valida los datos de la salida', async () => {
  await assert.rejects(loans.create('org', null, { productId: 5, productName: 'Tin', quantity: 1, location: ' ' }), { status: 400, message: 'Escribe dónde están las prendas' });
  await assert.rejects(loans.create('org', null, { productId: 5, productName: 'Tin', quantity: 0, location: 'Tienda' }), { message: 'La cantidad mínima es 1' });
  await assert.rejects(loans.create('org', null, { productId: 5, productName: 'Tin', quantity: 1, location: 'Tienda', returnDate: '02/11/2026' }), { message: 'Fecha de regreso inválida' });
  await assert.rejects(loans.update('org', 'x', { productId: 5, productName: 'Tin', quantity: 1, location: 'Tienda' }), { status: 404 });
});

test('regreso total cierra la salida; regreso parcial deja el resto fuera', async () => {
  const run = async (quantity) => {
    const calls = [];
    const client = { query: async (sql, args) => { calls.push({ sql, args }); return { rows: [{ id, quantity: 6 }] }; } };
    await withDb({ transaction: (fn) => fn(client) }, () => loans.returnItems('org', id, quantity == null ? {} : { quantity }));
    return calls.map((call) => call.sql.split(' ').slice(0, 3).join(' '));
  };
  assert.deepEqual(await run(), ['SELECT id, product_id', "UPDATE inventory_loans SET"]);
  assert.deepEqual(await run(2), ['SELECT id, product_id', 'INSERT INTO inventory_loans', 'UPDATE inventory_loans SET']);
  await assert.rejects(run(7), { status: 400, message: 'Solo hay 6 fuera' });
});
