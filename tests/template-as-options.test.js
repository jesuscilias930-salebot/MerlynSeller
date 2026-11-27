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
