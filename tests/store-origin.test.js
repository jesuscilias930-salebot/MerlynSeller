const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const shipping = require('../services/envia-shipping.service');

test('carrito requiere configuración propia, sin tomar origen manual', async () => {
  const original = db.query;
  db.query = async (sql, args) => {
    if (sql.includes('integration_features')) return { rows: [] };
    assert.match(sql, /FROM store_shipping_settings/);
    assert.deepEqual(args, ['org-1']);
    return { rows: [] };
  };
  try { await assert.rejects(shipping.quoteStore('org-1', {}), { status: 400 }); }
  finally { db.query = original; }
});

test('carrito usa origen y ambiente guardados para su organización', async () => {
  const originalQuery = db.query;
  const originalQuote = shipping.quote;
  const origin = { name: 'Almacén tienda' };
  db.query = async (sql, args) => {
    if (sql.includes('integration_features')) return { rows: [{ envia: 'production', stripe: 'sandbox' }] };
    assert.match(sql, /FROM store_shipping_settings/);
    assert.deepEqual(args, ['org-1']);
    return { rows: [{ origin, environment: 'production' }] };
  };
  shipping.quote = async (org, input, settings) => {
    assert.equal(org, 'org-1');
    assert.deepEqual(settings.origin, origin);
    assert.equal(settings.environment, 'production');
    assert.equal(input.destination.city, 'Destino');
    return { rates: [] };
  };
  try { assert.deepEqual(await shipping.quoteStore('org-1', { destination: { city: 'Destino' } }), { rates: [] }); }
  finally { db.query = originalQuery; shipping.quote = originalQuote; }
});

test('guardar origen no modifica la configuración manual y valida campos', async () => {
  const original = db.query;
  const origin = { name: 'Warehouse', phone: '1234567890', street: 'Main Street', city: 'Austin', state: 'TX', country: 'US', postalCode: '78701' };
  let writes = 0;
  db.query = async (sql, args) => {
    if (sql.includes('integration_features')) return { rows: [] };
    assert.match(sql, /store_shipping_settings/);
    assert.equal(args[0], 'org-1');
    if (sql.startsWith('INSERT')) {
      writes++;
      assert.equal(args[1], 'sandbox');
      assert.deepEqual(JSON.parse(args[2]), origin);
    }
    return { rows: [{ origin, environment: 'sandbox' }] };
  };
  try {
    await assert.rejects(shipping.saveStoreSettings('org-1', { environment: 'invalid', origin }), { status: 400 });
    assert.equal(writes, 0);
    await shipping.saveStoreSettings('org-1', { environment: 'sandbox', origin });
    assert.equal(writes, 1);
  } finally { db.query = original; }
});
