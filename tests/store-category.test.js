const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const categories = require('../services/store-category.service');

test('guarda solo las categorías con sección u orden propios', async () => {
  const calls = [];
  const client = { query: async (sql, args) => { calls.push({ sql, args }); return { rows: [] }; } };
  const original = db.transaction;
  db.transaction = (fn) => fn(client);
  try {
    await categories.save('org', { categories: [
      { categoryId: 5, categoryName: 'Essentials', section: ' Essentials ', position: 0 },
      { categoryId: 6, categoryName: 'Essentials High Quality', section: 'Essentials', position: 0 },
      { categoryId: 7, categoryName: 'Tines', section: 'Tines', position: 2 },
    ] });
  } finally { db.transaction = original; }
  const inserts = calls.filter((call) => call.sql.startsWith('INSERT'));
  assert.deepEqual(inserts.map((call) => call.args), [['org', 6, 'Essentials High Quality', 'Essentials', 0], ['org', 7, 'Tines', 'Tines', 2]]);
});

test('valida la configuración', async () => {
  await assert.rejects(categories.save('org', { categories: [{ categoryId: 5, categoryName: 'A', section: ' ' }] }), { status: 400, message: 'Escribe en qué sección se muestra cada categoría' });
  await assert.rejects(categories.save('org', { categories: [{ categoryId: 5, categoryName: 'A', section: 'A' }, { categoryId: 5, categoryName: 'A', section: 'B' }] }), { message: 'Hay categorías repetidas' });
});
