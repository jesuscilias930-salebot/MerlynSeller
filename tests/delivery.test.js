const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const deliveries = require('../services/delivery.service');

const id = '11111111-1111-4111-8111-111111111111';
const conv = '22222222-2222-4222-8222-222222222222';
const base = { customerName: 'Ana López', customerPhone: '5212721234567', location: 'Parque Castillo, Orizaba', scheduledAt: '2026-10-25T17:30:00.000Z', products: [{ kind: 'bundle', id: 7, name: 'Caricatura 50 pares', quantity: 1 }, { kind: 'custom', name: 'Bolsa de regalo', quantity: 2 }], notes: 'Paga en efectivo' };
const withDb = async (handler, run) => { const original = db.query; db.query = handler; try { return await run(); } finally { db.query = original; } };

test('crea una entrega ligada al chat del negocio', async () => {
  const calls = [];
  const row = await withDb(async (sql, args) => {
    calls.push({ sql, args });
    if (sql.startsWith('SELECT 1 FROM conversations')) return { rows: [{ ok: 1 }] };
    return { rows: [{ id, customerName: args[2] }] };
  }, () => deliveries.create('org', { ...base, conversationId: conv }));
  assert.equal(row.id, id);
  const insert = calls.find((call) => call.sql.includes('INSERT INTO delivery_appointments'));
  assert.deepEqual(insert.args.slice(0, 5), ['org', conv, 'Ana López', '5212721234567', 'Parque Castillo, Orizaba']);
  assert.equal(insert.args[5].toISOString(), '2026-10-25T17:30:00.000Z');
  assert.equal(JSON.parse(insert.args[6]).length, 2);
});

test('valida datos de la entrega con mensajes claros', async () => {
  await assert.rejects(deliveries.create('org', { ...base, customerName: ' ' }), { status: 400, message: 'Escribe el nombre del cliente' });
  await assert.rejects(deliveries.create('org', { ...base, location: '' }), { message: 'Escribe el lugar de entrega' });
  await assert.rejects(deliveries.create('org', { ...base, scheduledAt: 'mañana' }), { message: 'Indica una fecha y hora válidas' });
  await assert.rejects(deliveries.create('org', { ...base, products: [{ kind: 'product', name: 'X', quantity: 1 }] }), { message: 'Selecciona un producto del inventario' });
  await withDb(async () => ({ rows: [] }), () => assert.rejects(deliveries.create('org', { ...base, conversationId: conv }), { message: 'La conversación no pertenece a tu negocio' }));
});

test('registra la venta una sola vez y la marca como entregada', async () => {
  const sale = { amount: '446.50', paymentMethod: 'cash', items: [{ kind: 'bundle', id: 7, name: 'Caricatura 50 pares', quantity: 1 }], controlSaleId: 321 };
  let recorded = false;
  const handler = async (sql, args) => {
    if (sql.startsWith('UPDATE delivery_appointments SET sale_amount')) {
      if (recorded) return { rows: [] };
      recorded = true;
      assert.deepEqual(args.slice(2), ['446.50', 'cash', JSON.stringify(sale.items), 321, true]);
      return { rows: [{ id, status: 'delivered', saleAmount: '446.50' }] };
    }
    if (sql.startsWith('SELECT status, sale_recorded_at')) return { rows: [{ status: 'delivered', sale_recorded_at: new Date() }] };
    return { rows: [] };
  };
  await withDb(handler, async () => {
    assert.equal((await deliveries.recordSale('org', id, sale)).status, 'delivered');
    await assert.rejects(deliveries.recordSale('org', id, sale), { status: 409, message: 'Esta entrega ya tiene una venta registrada' });
  });
  await assert.rejects(deliveries.recordSale('org', id, { ...sale, amount: 0 }), { message: 'Indica un monto mayor a 0' });
  await assert.rejects(deliveries.recordSale('org', id, { ...sale, paymentMethod: 'bitcoin' }), { message: 'Elige el tipo de pago' });
  await assert.rejects(deliveries.recordSale('org', id, { ...sale, items: [{ kind: 'custom', name: 'Bolsa', quantity: 1 }] }), { message: 'La venta solo admite productos o bundles del inventario' });
  await assert.rejects(deliveries.recordSale('org', 'x', sale), { status: 404 });
});

test('no cancela ni elimina entregas con venta', async () => {
  await withDb(async (sql) => sql.startsWith('SELECT sale_recorded_at') ? { rows: [{ sale_recorded_at: new Date() }] } : { rows: [] },
    () => assert.rejects(deliveries.setStatus('org', id, { status: 'cancelled' }), { status: 409 }));
  await withDb(async (sql) => sql.startsWith('SELECT 1 FROM delivery_appointments') ? { rows: [{}] } : { rows: [] },
    () => assert.rejects(deliveries.remove('org', id), { message: 'No se puede eliminar una entrega con venta registrada' }));
});
