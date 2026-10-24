const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const queue = require('../lib/queue');
const reminders = require('../services/reminder.service');
const sales = require('../services/pending-sale.service');
const templates = require('../services/whatsapp-template.service');
const chat = require('../services/internal-chat.service');

const id = '11111111-1111-4111-8111-111111111111';
const saleId = '33333333-3333-4333-8333-333333333333';
const templateId = '44444444-4444-4444-8444-444444444444';
const products = [{ kind: 'product', id: 5, name: 'Essential High Quality · Negro · Talla 25-28', quantity: 12 }];
const base = { contactName: 'Ana López', phone: '272 123 4567', remindAt: '2026-10-25T16:00:00.000Z', products, notes: 'Pidió precio de mayoreo' };
const approved = { id: templateId, name: 'recordatorio_pedido', language: 'es_MX', status: 'APPROVED', components: [{ type: 'BODY', text: 'Hola {{1}}, te recordamos tu pedido: {{2}}. Quedamos el {{3}}.' }] };
const mappings = [1, 2, 3].map((position, index) => ({ component: 'body', position, source: ['reminder.name', 'reminder.products', 'reminder.agreed_date'][index] }));
const withDb = async (handlers, run) => {
  const original = { query: db.query, transaction: db.transaction };
  Object.assign(db, handlers);
  try { return await run(); } finally { Object.assign(db, original); }
};

test('crear un recordatorio crea su venta pendiente y lo liga al chat existente', async () => {
  const calls = [];
  const client = { query: async (sql, args) => {
    calls.push({ sql, args });
    if (sql.includes('FROM contacts c JOIN conversations')) return { rows: [{ id: 'conv-1' }] };
    if (sql.startsWith('INSERT INTO pending_sales')) return { rows: [{ id: saleId }] };
    if (sql.startsWith('INSERT INTO reminders')) return { rows: [{ id }] };
    return { rows: [{ id, saleId, saleStatus: 'open' }] };
  } };
  const row = await withDb({ transaction: (fn) => fn(client) }, () => reminders.create('org', 'user', base));
  assert.equal(row.saleId, saleId);
  assert.deepEqual(calls[0].args[1], ['522721234567', '5212721234567'], 'busca el número con y sin el 1');
  assert.deepEqual(calls[1].args.slice(0, 4), ['org', 'conv-1', 'Ana López', '522721234567']);
  const insert = calls[2].args;
  assert.equal(insert[7], saleId); assert.equal(insert[8], 'manual'); assert.equal(insert[9], null); assert.equal(insert[12], 'conv-1');
});

test('valida los datos y la plantilla del recordatorio', async () => {
  await assert.rejects(reminders.create('org', null, { ...base, contactName: ' ' }), { status: 400, message: 'Escribe el nombre de la persona' });
  await assert.rejects(reminders.create('org', null, { ...base, phone: '123' }), { message: 'Escribe un celular válido (10 dígitos o con lada de país)' });
  await assert.rejects(reminders.create('org', null, { ...base, sendMode: 'template' }), { message: 'Elige la plantilla de WhatsApp para el envío automático' });
  const query = async () => ({ rows: [approved] });
  await withDb({ query }, async () => {
    await assert.rejects(reminders.create('org', null, { ...base, sendMode: 'template', templateId, templateMappings: mappings.slice(0, 2) }), { message: 'Elige qué va en la variable {{3}} de la plantilla «recordatorio_pedido».' });
    await assert.rejects(reminders.create('org', null, { ...base, sendMode: 'template', templateId, templateMappings: mappings }), { message: 'Falta el valor de {{3}} (fecha acordada).' });
  });
  await withDb({ query: async () => ({ rows: [{ ...approved, status: 'PAUSED' }] }) }, () => assert.rejects(templates.resolveForReminder('org', templateId, mappings, {}), { message: 'La plantilla «recordatorio_pedido» no está aprobada por WhatsApp (PAUSED).' }));
});

test('la plantilla se llena con nombre, productos en una línea y fecha acordada', async () => {
  const values = reminders.templateValues({ contactName: 'Ana López', products: [...products, { kind: 'custom', name: 'Bolsa', quantity: 2 }], agreedDate: '2026-10-31' });
  assert.deepEqual(values, { 'reminder.name': 'Ana López', 'reminder.products': '12 × Essential High Quality · Negro · Talla 25-28, 2 × Bolsa', 'reminder.agreed_date': 'sábado, 31 de octubre' });
  const resolved = await withDb({ query: async () => ({ rows: [approved] }) }, () => templates.resolveForReminder('org', templateId, mappings, values));
  assert.deepEqual(resolved.components[0].parameters.map((p) => p.text), ['Ana López', values['reminder.products'], 'sábado, 31 de octubre']);
});

test('al llegar la hora: manual avisa en el chat; plantilla se envía y avisa al confirmarse', async () => {
  const calls = []; const jobs = [];
  const due = [
    { id, organizationId: 'org', contactName: 'Ana López', phone: '522721234567', products, notes: null, agreedDate: null, sendMode: 'manual', saleId },
    { id: 'r2', organizationId: 'org', contactName: 'Luis', phone: '522725556677', products, notes: null, agreedDate: '2026-10-31', sendMode: 'template', templateId, templateMappings: mappings, conversationId: 'conv-2', saleId: 's2' },
  ];
  const query = async (sql, args) => {
    calls.push({ sql, args });
    if (sql.startsWith('UPDATE reminders r SET notified_at')) return { rows: due };
    if (sql.startsWith('SELECT * FROM whatsapp_templates')) return { rows: [approved] };
    if (sql.startsWith('INSERT INTO messages')) return { rows: [{ id: 'msg-1' }] };
    if (sql.includes('WHERE r.sent_message_id=$1')) return { rows: [{ ...due[1], templateName: 'recordatorio_pedido' }] };
    return { rows: [] };
  };
  const originalQueue = queue.outboundQueue;
  queue.outboundQueue = () => ({ add: async (...job) => { jobs.push(job); } });
  try {
    const orgs = await withDb({ query }, () => reminders.deliverDue());
    assert.deepEqual(orgs, ['org'], 'solo el manual avisa de inmediato');
    assert.match(calls[0].sql, /status <> 'open'/, 'omite ventas cerradas');
    const manual = calls.find((call) => call.sql.startsWith('INSERT INTO internal_messages'));
    assert.match(manual.args[1], /^⏰ Es hora de escribirle a Ana López \(\+52 272 123 4567\)\./);
    const message = calls.find((call) => call.sql.startsWith('INSERT INTO messages'));
    assert.equal(message.args[1], 'conv-2');
    assert.deepEqual(JSON.parse(message.args[2]).components[0].parameters.map((p) => p.text), ['Luis', '12 × Essential High Quality · Negro · Talla 25-28', 'sábado, 31 de octubre']);
    assert.deepEqual(jobs[0], ['send-template', { messageId: 'msg-1' }, { jobId: 'msg-1' }]);
    calls.length = 0;
    assert.equal(await withDb({ query }, () => reminders.onTemplateResult('msg-1', 'sent')), 'org');
    const sent = calls.find((call) => call.sql.startsWith('INSERT INTO internal_messages'));
    assert.match(sent.args[1], /^✅ Se envió el recordatorio automático a Luis/);
    assert.equal(JSON.parse(sent.args[3]).conversationId, 'conv-2');
  } finally { queue.outboundQueue = originalQueue; }
});

test('cerrar la venta antes del recordatorio lo cancela', async () => {
  const calls = [];
  const query = async (sql, args) => {
    calls.push({ sql, args });
    if (sql.startsWith('UPDATE pending_sales')) return { rows: [{ id: saleId }] };
    if (sql.startsWith('UPDATE reminders')) return { rows: [{ id, status: 'cancelled' }] };
    return { rows: [{ id: saleId, status: 'paid' }] };
  };
  const pay = { amount: '446.50', paymentMethod: 'cash', items: products, controlSaleId: 321 };
  await withDb({ query }, () => sales.pay('org', saleId, pay));
  assert.deepEqual(calls[0].args.slice(2), ['446.50', 'cash', JSON.stringify(products), 321]);
  assert.match(calls[1].sql, /CASE WHEN notified_at IS NULL THEN 'cancelled' ELSE 'done' END/);
  await withDb({ query }, () => sales.cancel('org', saleId));
  await assert.rejects(sales.pay('org', saleId, { ...pay, paymentMethod: 'x' }), { message: 'Elige el tipo de pago' });
  await withDb({ query: async (sql) => ({ rows: sql.startsWith('UPDATE') ? [] : [{ id: saleId, status: 'cancelled' }] }) }, () => assert.rejects(sales.pay('org', saleId, pay), { status: 409, message: 'Esta venta se cerró sin pago; no se puede cobrar.' }));
});

test('notas del chat interno', async () => {
  await assert.rejects(chat.addNote('org', 'user', { body: '  ' }), { status: 400, message: 'Escribe la nota' });
  const row = await withDb({ query: async (sql, args) => ({ rows: [{ id, body: args[1], kind: 'note' }] }) }, () => chat.addNote('org', 'user', { body: ' Llamar mañana ' }));
  assert.equal(row.body, 'Llamar mañana');
});
