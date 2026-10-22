const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const details = require('../services/product-detail.service');

// Simula una fila en memoria para revisar la lógica de conservar/borrar campos.
const fakeDb = () => {
  const rows = new Map(); const calls = [];
  const client = { query: async (sql, args) => {
    calls.push(sql);
    if (sql.startsWith('INSERT')) {
      const [, id, color, model, setColor, setModel] = args;
      const current = rows.get(id) || { productId: id, color: null, model: null };
      const next = rows.has(id) ? { productId: id, color: setColor ? color : current.color, model: setModel ? model : current.model } : { productId: id, color, model };
      rows.set(id, next);
      return { rows: [next] };
    }
    if (sql.startsWith('DELETE')) { rows.delete(args[1]); return { rows: [] }; }
    return { rows: [] };
  } };
  return { rows, calls, client };
};
const withDb = async (fake, run) => {
  const original = db.transaction;
  db.transaction = (callback) => callback(fake.client);
  try { return await run(); } finally { db.transaction = original; }
};

test('guarda color y modelo; un campo ausente se conserva', async () => {
  const fake = fakeDb();
  await withDb(fake, async () => {
    assert.deepEqual(await details.save('org', '7', { color: '  Azul   marino ' }), { productId: 7, color: 'Azul marino', model: null });
    assert.deepEqual(await details.save('org', 7, { model: 'Deportiva  algodón' }), { productId: 7, color: 'Azul marino', model: 'Deportiva algodón' });
    assert.deepEqual(await details.save('org', 7, { color: '' }), { productId: 7, color: null, model: 'Deportiva algodón' });
    assert.deepEqual(await details.save('org', 7, { model: null }), { productId: 7, color: null, model: null });
  });
  assert.equal(fake.rows.size, 0);
  assert.match(fake.calls.at(-1), /^DELETE FROM product_details/);
});

test('guarda varias variantes en una transacción', async () => {
  const fake = fakeDb();
  const saved = await withDb(fake, () => details.saveMany('org', [{ productId: 1, color: 'Negro', model: 'Tobillera' }, { productId: 2, color: 'Blanco', model: 'Tobillera' }]));
  assert.deepEqual(saved.map((row) => [row.productId, row.color, row.model]), [[1, 'Negro', 'Tobillera'], [2, 'Blanco', 'Tobillera']]);
});

test('valida producto, largo y lista', async () => {
  await assert.rejects(details.save('org', 'x', { color: 'Rojo' }), { status: 400, message: 'Producto inválido' });
  await assert.rejects(details.save('org', 3, { color: 'r'.repeat(41) }), { message: 'El color admite máximo 40 caracteres' });
  await assert.rejects(details.save('org', 3, { model: 'm'.repeat(81) }), { message: 'El modelo admite máximo 80 caracteres' });
  await assert.rejects(details.saveMany('org', []), { message: 'Indica al menos un producto' });
  await assert.rejects(details.saveMany('org', [{ productId: 1 }, { productId: 1 }]), { message: 'Un producto aparece dos veces' });
});
