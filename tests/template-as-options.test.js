const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const templates = require('../services/whatsapp-template.service');
const followUps = require('../services/follow-up.service');
const scenarios = require('../services/scenario.service');

const TPL = '11111111-1111-4111-8111-111111111111';
const template = (extra = {}) => ({
  id: TPL, name: 'remarketin120', status: 'APPROVED',
  components: [
    { type: 'HEADER', format: 'TEXT', text: '¿Seguimos con tu caja de 120 pares? 📦' },
    { type: 'BODY', text: 'Hola {{1}} 👋 Te escribe Merlyn Mayoreo. ¿Te la apartamos?' },
    { type: 'FOOTER', text: 'Merlyn Mayoreo' },
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Sí, la quiero' }, { type: 'QUICK_REPLY', text: 'Tengo una duda' }, { type: 'QUICK_REPLY', text: 'Ya no me interesa' }] },
  ],
  variable_mappings: [{ component: 'body', position: 1, source: 'contact.name' }],
  ...extra,
});

test('plantilla → mensaje con los mismos botones y variables resueltas', () => {
  assert.deepEqual(templates.renderAsOptions(template(), { name: 'María' }), {
    header: '¿Seguimos con tu caja de 120 pares? 📦',
    body: 'Hola María 👋 Te escribe Merlyn Mayoreo. ¿Te la apartamos?',
    footer: 'Merlyn Mayoreo',
    options: [{ title: 'Sí, la quiero' }, { title: 'Tengo una duda' }, { title: 'Ya no me interesa' }],
  });
  const withUrl = template(); withUrl.components[3] = { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Ver', url: 'https://x' }] };
  assert.equal(templates.renderAsOptions(withUrl, { name: 'M' }), null, 'botón de enlace: no se puede');
  const withImage = template(); withImage.components[0] = { type: 'HEADER', format: 'IMAGE' };
  assert.equal(templates.renderAsOptions(withImage, { name: 'M' }), null, 'encabezado con imagen: no se puede');
});

test('seguimiento: dentro de 24 h con «plantilla con botones» envía aunque no haya mensaje libre', () => {
  const step = { waitMinutes: 60, imageIds: [], templateId: TPL, templateInWindow: true };
  const base = { step, lastOutAt: '2026-11-27T15:00:00Z', lastInAt: '2026-11-27T14:00:00Z', now: new Date('2026-11-27T18:00:00Z') };
  assert.equal(followUps.decide(base).action, 'send');
  assert.equal(followUps.decide({ ...base, step: { ...step, templateInWindow: undefined } }).action, 'template', 'sin la opción: dentro de 24 h no había qué mandar gratis');
  assert.equal(followUps.decide({ ...base, lastInAt: '2026-11-25T14:00:00Z', lastOutAt: '2026-11-25T15:00:00Z' }).action, 'template', 'fuera de 24 h: la plantilla oficial');
});

test('la respuesta a un mensaje con botones de plantilla cuenta como respuesta a esa plantilla', async () => {
  const original = db.query;
  db.query = async (sql) => {
    if (sql.includes("type IN ('template', 'interactive')")) return { rows: [{ id: 'm1', body: JSON.stringify({ kind: 'options', body: 'Hola', options: [], templateId: TPL }) }] };
    if (sql.includes('JOIN messages inbound')) return { rows: [{ id: 'm2', direction: 'outbound', type: 'interactive', status: 'read', created_at: new Date().toISOString(), body: JSON.stringify({ kind: 'options', templateId: TPL }) }] };
    return { rows: [] };
  };
  try {
    assert.deepEqual(await scenarios.templateReplyContext('org', 'conv', { id: 'w1', context: { id: 'wamid.x' } }), { templateId: TPL, messageId: 'm1' });
    assert.deepEqual(await scenarios.templateReplyContext('org', 'conv', { id: 'w2' }), { templateId: TPL, messageId: 'm2' });
  } finally { db.query = original; }
  db.query = async (sql) => (sql.includes('JOIN messages inbound') ? { rows: [{ id: 'm3', direction: 'outbound', type: 'interactive', status: 'read', created_at: new Date().toISOString(), body: JSON.stringify({ kind: 'options' }) }] } : { rows: [] });
  try {
    assert.equal(await scenarios.templateReplyContext('org', 'conv', { id: 'w3' }), null, 'opciones normales (sin plantilla) no cuentan');
  } finally { db.query = original; }
});

test('📣 con plantilla y «gratis dentro de 24 h»: botones gratis a quien está en la ventana, plantilla al resto', async () => {
  const remarketing = require('../services/remarketing.service');
  require('../services/remarketing-schedule.service').deferUntil = async () => null;
  const queue = require('../lib/queue'); const originalQueue = queue.outboundQueue; queue.outboundQueue = () => ({ add: async () => {} });
  const realtime = require('../lib/realtime'); const originalPublish = realtime.publish; realtime.publish = async () => {};
  const original = { transaction: db.transaction };
  const inserted = [];
  const client = { query: async (sql, args) => {
    if (sql.includes('FROM lead_columns WHERE id')) return { rows: [{ id: 'col' }] };
    if (sql.includes('FROM whatsapp_templates')) return { rows: [template()] };
    if (sql.includes('FROM conversations c JOIN contacts')) return { rows: [
      { id: 'reciente', name: 'Ana', phone_number: '521', channel: 'whatsapp', recent: false, lastInboundAt: new Date(Date.now() - 2 * 3600e3).toISOString() },
      { id: 'viejo', name: 'Luis', phone_number: '522', channel: 'whatsapp', recent: false, lastInboundAt: new Date(Date.now() - 48 * 3600e3).toISOString() },
    ] };
    if (sql.includes('remarketing_move_rules')) return { rows: [] };
    if (sql.includes('INSERT INTO remarketing_campaigns')) return { rows: [{ id: 'camp' }] };
    if (sql.includes('INSERT INTO messages')) { inserted.push({ conversation: args[1], type: args[6], body: JSON.parse(args[2]) }); return { rows: [{ id: `m-${args[1]}` }] }; }
    return { rows: [] };
  } };
  db.transaction = async (callback) => callback(client);
  try {
    const result = await remarketing.queueTemplateCampaign('org', { columnId: '22222222-2222-4222-8222-222222222222', templateId: TPL, freeInWindow: true });
    assert.equal(result.free, 1);
    assert.deepEqual(inserted.map((item) => [item.conversation, item.type]), [['reciente', 'interactive'], ['viejo', 'template']]);
    assert.equal(inserted[0].body.templateId, TPL, 'las respuestas se ligan a la plantilla');
    assert.equal(inserted[0].body.body, 'Hola Ana 👋 Te escribe Merlyn Mayoreo. ¿Te la apartamos?');
    assert.deepEqual(inserted[0].body.options.map((option) => option.title), ['Sí, la quiero', 'Tengo una duda', 'Ya no me interesa']);
  } finally { db.transaction = original.transaction; queue.outboundQueue = originalQueue; realtime.publish = originalPublish; }
});
