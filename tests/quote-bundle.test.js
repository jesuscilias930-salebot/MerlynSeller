const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const scenarios = require('../services/scenario.service');
const conversations = require('../services/conversation.service');

const steps = [{ id: 'hola', type: 'send_text', label: 'Saludo', body: 'Hola', nextStepId: 'fin' }, { id: 'fin', type: 'end', label: 'Fin' }];

test('el escenario guarda el paquete del cotizador y lo normaliza', () => {
  const value = scenarios.parseDefinition({ name: 'Mayoreo 100', triggerExamples: ['quiero 100 pares'], steps, quoteBundle: { id: 12, name: ' Paquete 100 pares ' } });
  assert.deepEqual(value.quoteBundle, { id: '12', name: 'Paquete 100 pares' });
  assert.equal(scenarios.parseDefinition({ name: 'Sin paquete', triggerExamples: ['hola'], steps }).quoteBundle, undefined);
  assert.throws(() => scenarios.parseDefinition({ name: 'Malo', triggerExamples: ['hola'], steps, quoteBundle: { id: 3, name: '' } }));
});

test('al iniciar el escenario el chat queda con su paquete para cotizar', async () => {
  const row = { ...scenarios.parseDefinition({ name: 'Mayoreo', triggerExamples: ['quiero 100 pares'], steps, quoteBundle: { id: 7, name: 'Paquete 100' } }), id: 's1', key: 'mayoreo', isActive: true, canInterrupt: true, position: 0, priority: 0 };
  const original = { query: db.query, list: scenarios.list, text: conversations.queueText };
  const updates = [];
  db.query = async (sql, args) => {
    if (sql.includes('quote_bundle_id')) updates.push(args);
    if (sql.includes('scenario_enabled')) return { rows: [{ scenario_enabled: true }] };
    return { rows: [] };
  };
  scenarios.list = async () => [row];
  conversations.queueText = async () => ({});
  try {
    assert.deepEqual(await scenarios.processIncoming('org', 'conv', 'quiero 100 pares'), { handled: true, requiresHuman: false });
    assert.deepEqual(updates, [['conv', 'org', '7', 'Paquete 100']]);
  } finally { db.query = original.query; scenarios.list = original.list; conversations.queueText = original.text; }
});

test('un escenario sin paquete no cambia el que eligió la persona', async () => {
  const row = { ...scenarios.parseDefinition({ name: 'Saludo', triggerExamples: ['hola'], steps }), id: 's2', key: 'saludo', isActive: true, canInterrupt: true, position: 0, priority: 0, quoteBundle: null };
  const original = { query: db.query, list: scenarios.list, text: conversations.queueText };
  const updates = [];
  db.query = async (sql) => { if (sql.includes('quote_bundle_id')) updates.push(sql); return sql.includes('scenario_enabled') ? { rows: [{ scenario_enabled: true }] } : { rows: [] }; };
  scenarios.list = async () => [row];
  conversations.queueText = async () => ({});
  try {
    await scenarios.processIncoming('org', 'conv', 'hola');
    assert.equal(updates.length, 0);
  } finally { db.query = original.query; scenarios.list = original.list; conversations.queueText = original.text; }
});

test('el paquete del chat se cambia o se quita desde el Inbox', async () => {
  const original = db.query;
  const calls = [];
  db.query = async (sql, args) => { calls.push(args); return { rows: [{ quoteBundleId: args[2], quoteBundleName: args[3] }] }; };
  try {
    assert.deepEqual(await conversations.setQuoteBundle('org', 'conv', { bundle: { id: 4, name: 'Paquete 50' } }), { quoteBundleId: '4', quoteBundleName: 'Paquete 50' });
    assert.deepEqual(await conversations.setQuoteBundle('org', 'conv', { bundle: null }), { quoteBundleId: null, quoteBundleName: null });
    await assert.rejects(conversations.setQuoteBundle('org', 'conv', {}), { status: 400 });
  } finally { db.query = original; }
});
