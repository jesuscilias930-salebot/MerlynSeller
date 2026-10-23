const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const reminders = require('../services/reminder.service');
const chat = require('../services/internal-chat.service');

const id = '11111111-1111-4111-8111-111111111111';
const base = { contactName: 'Ana López', phone: '272 123 4567', remindAt: '2026-10-25T16:00:00.000Z', products: [{ kind: 'product', id: 5, name: 'Essential High Quality · Negro · Talla 25-28', quantity: 12 }], notes: 'Pidió precio de mayoreo' };
const withDb = async (handlers, run) => {
  const original = { query: db.query, transaction: db.transaction };
  Object.assign(db, handlers);
  try { return await run(); } finally { Object.assign(db, original); }
};

test('crea un recordatorio y normaliza el celular de México', async () => {
  let insert;
  const row = await withDb({ query: async (sql, args) => { insert = { sql, args }; return { rows: [{ id }] }; } }, () => reminders.create('org', 'user', base));
  assert.equal(row.id, id);
  assert.deepEqual(insert.args.slice(0, 3), ['org', 'Ana López', '522721234567']);
  assert.equal(JSON.parse(insert.args[3]).length, 1);
  assert.equal(insert.args[5].toISOString(), '2026-10-25T16:00:00.000Z');
  assert.equal(insert.args[6], 'user');
  assert.equal(reminders.normalizePhone('+52 1 272 123 4567'), '5212721234567');
});

test('valida los datos del recordatorio', async () => {
  await assert.rejects(reminders.create('org', null, { ...base, contactName: ' ' }), { status: 400, message: 'Escribe el nombre de la persona' });
  await assert.rejects(reminders.create('org', null, { ...base, phone: '123' }), { message: 'Escribe un celular válido (10 dígitos o con lada de país)' });
  await assert.rejects(reminders.create('org', null, { ...base, remindAt: 'mañana' }), { message: 'Indica la fecha y hora del recordatorio' });
  await assert.rejects(reminders.setStatus('org', id, { status: 'x' }), { message: 'Estado inválido' });
  await assert.rejects(reminders.list('org', { view: 'x' }), { message: 'Filtro inválido' });
});

test('al cambiar la hora se vuelve a avisar', async () => {
  let update;
  await withDb({ query: async (sql, args) => { update = sql; return { rows: [{ id }] }; } }, () => reminders.update('org', id, base));
  assert.match(update, /notified_at = CASE WHEN remind_at = \$7 THEN notified_at ELSE NULL END/);
});

test('publica en el chat interno los recordatorios vencidos una sola vez', async () => {
  const calls = [];
  const due = { id, organizationId: 'org', contactName: 'Ana López', phone: '522721234567', products: base.products, notes: 'Pidió precio de mayoreo', remindAt: base.remindAt };
  const client = { query: async (sql, args) => { calls.push({ sql, args }); return { rows: sql.startsWith('UPDATE reminders') ? [due] : [] }; } };
  const orgs = await withDb({ transaction: (fn) => fn(client) }, () => reminders.deliverDue());
  assert.deepEqual(orgs, ['org']);
  assert.match(calls[0].sql, /FOR UPDATE SKIP LOCKED/);
  const insert = calls[1];
  assert.match(insert.sql, /INSERT INTO internal_messages/);
  assert.equal(insert.args[1], '⏰ Es hora de escribirle a Ana López (+52 272 123 4567).\n\nQuiere comprar:\n• 12 × Essential High Quality · Negro · Talla 25-28\n\nNotas: Pidió precio de mayoreo');
  assert.equal(JSON.parse(insert.args[3]).phone, '522721234567');
});

test('notas del chat interno', async () => {
  await assert.rejects(chat.addNote('org', 'user', { body: '  ' }), { status: 400, message: 'Escribe la nota' });
  const row = await withDb({ query: async (sql, args) => ({ rows: [{ id, body: args[1], kind: 'note' }] }) }, () => chat.addNote('org', 'user', { body: ' Llamar mañana ' }));
  assert.equal(row.body, 'Llamar mañana');
});
