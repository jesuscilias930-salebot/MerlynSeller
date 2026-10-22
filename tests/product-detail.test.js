const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const details = require('../services/product-detail.service');

const withDb = async (handler, run) => { const original = db.query; db.query = handler; try { return await run(); } finally { db.query = original; } };

test('guarda, limpia y borra el color', async () => {
  const calls = [];
  const handler = async (sql, args) => { calls.push({ sql, args }); return { rows: [{ productId: args[1], color: args[2] }] }; };
  assert.deepEqual(await withDb(handler, () => details.save('org', '7', { color: '  Azul   marino ' })), { productId: 7, color: 'Azul marino' });
  assert.match(calls[0].sql, /ON CONFLICT/);
  assert.deepEqual(await withDb(handler, () => details.save('org', 7, { color: ' ' })), { productId: 7, color: null });
  assert.match(calls[1].sql, /^DELETE FROM product_details/);
});

test('valida producto y largo', async () => {
  await assert.rejects(details.save('org', 'x', { color: 'Rojo' }), { status: 400, message: 'Producto inválido' });
  await assert.rejects(details.save('org', 3, { color: 'r'.repeat(41) }), { message: 'El color admite máximo 40 caracteres' });
});
