const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const db = require('../lib/db');

const secret = 's'.repeat(40);
const start = async () => {
  process.env.STORE_CATALOG_SECRET = secret;
  process.env.STORE_ORGANIZATION_ID = 'org-store';
  const app = express();
  app.use('/store-orders', require('../routes/store-orders.routes'));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/store-orders/catalog-details` };
};

test('la tienda lee color y modelo solo con el secreto compartido', async () => {
  const { server, url } = await start();
  const original = db.query;
  let args;
  db.query = async (sql, values) => { args = values; return { rows: [{ productId: 5, color: 'Negro', model: 'Essential High Quality' }] }; };
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { 'X-Store-Secret': 'x'.repeat(40) } })).status, 401);
    const response = await fetch(url, { headers: { 'X-Store-Secret': secret } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [{ productId: 5, color: 'Negro', model: 'Essential High Quality' }]);
    assert.deepEqual(args, ['org-store']);
  } finally { db.query = original; server.close(); }
});
