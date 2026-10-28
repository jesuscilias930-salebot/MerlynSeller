const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const queue = require('../lib/queue');
const realtime = require('../lib/realtime');
const remarketing = require('../services/remarketing.service');

const columnId = '22222222-2222-4222-8222-222222222222';
const templateId = '44444444-4444-4444-8444-444444444444';
const templateRow = { id: templateId, name: 'catalogo_mayoreo', language: 'es_MX', status: 'APPROVED', components: [{ type: 'BODY', text: 'Hola {{1}}, actualizamos el catálogo.' }], variable_mappings: [{ component: 'body', position: 1, source: 'contact.name' }] };

test('resume a quién se envía y por qué se omite al resto', () => {
  const rows = [
    { id: 'a', channel: 'whatsapp', recent: false }, { id: 'b', channel: 'whatsapp', recent: true },
    { id: 'c', channel: 'messenger', recent: false }, { id: 'd', channel: 'whatsapp', recent: false },
  ];
  const saved = process.env.REMARKETING_TEMPLATE_MAX; process.env.REMARKETING_TEMPLATE_MAX = '1';
  try {
    const summary = remarketing.audienceSummary(rows);
    assert.deepEqual({ ...summary, recipients: summary.recipients.map((row) => row.id) }, { total: 4, eligible: 1, otherChannel: 1, recent: 1, overLimit: 1, max: 1, recipients: ['a'] });
  } finally { if (saved === undefined) delete process.env.REMARKETING_TEMPLATE_MAX; else process.env.REMARKETING_TEMPLATE_MAX = saved; }
});

test('encola la plantilla con el nombre de cada lead y omite a quien no tiene el dato', async () => {
  const calls = []; const jobs = [];
  const client = { query: async (sql, args) => {
    calls.push({ sql, args });
    if (sql.startsWith('SELECT id FROM lead_columns')) return { rows: [{ id: columnId }] };
    if (sql.includes('FROM whatsapp_templates')) return { rows: [templateRow] };
    if (sql.includes('FROM conversations c JOIN contacts')) return { rows: [{ id: 'c1', name: 'Ana', phone_number: '521', channel: 'whatsapp', recent: false }, { id: 'c2', name: null, phone_number: '522', channel: 'whatsapp', recent: false }] };
    if (sql.includes('INSERT INTO remarketing_campaigns')) return { rows: [{ id: 'camp' }] };
    if (sql.includes('INSERT INTO messages')) return { rows: [{ id: `m${calls.length}` }] };
    return { rows: [] };
  } };
  const original = { transaction: db.transaction, queue: queue.outboundQueue, publish: realtime.publish };
  db.transaction = (fn) => fn(client);
  queue.outboundQueue = () => ({ add: async (...args) => jobs.push(args) });
  realtime.publish = async () => {};
  try {
    const result = await remarketing.queueTemplateCampaign('org', { columnId, templateId });
    assert.equal(result.queued, 1);
    assert.equal(result.skipped.missingData, 1);
    const message = calls.find((call) => call.sql.includes('INSERT INTO messages'));
    assert.deepEqual(JSON.parse(message.args[2]).components, [{ type: 'body', parameters: [{ type: 'text', text: 'Ana' }] }]);
    assert.equal(jobs.length, 1);
  } finally { db.transaction = original.transaction; queue.outboundQueue = original.queue; realtime.publish = original.publish; }
});
