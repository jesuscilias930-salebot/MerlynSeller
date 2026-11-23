const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const scenarios = require('../services/scenario.service');
const conversations = require('../services/conversation.service');
const reuse = require('../services/video-reuse.service');
const mcp = require('../services/scenario-mcp.service');

const V1 = '11111111-1111-4111-8111-111111111111', V2 = '22222222-2222-4222-8222-222222222222';
const definition = {
  name: 'Ver bodega', triggerExamples: ['quiero ver la bodega'], steps: [
    { id: 'videos', type: 'send_media', label: 'Videos', savedVideos: [{ videoId: V1, caption: 'Así es nuestra bodega 📦', label: 'Recorrido' }, { videoId: V2, label: 'Promo' }], nextStepId: 'fin' },
    { id: 'fin', type: 'end', label: 'Fin' },
  ],
};

test('el paso de archivos acepta solo videos guardados, con o sin mensaje', () => {
  const parsed = scenarios.parseDefinition(definition);
  assert.equal(parsed.steps[0].savedVideos.length, 2);
  assert.equal(parsed.steps[0].savedVideos[1].caption, undefined);
  assert.throws(() => scenarios.parseDefinition({ ...definition, steps: [{ ...definition.steps[0], savedVideos: [{ videoId: 'x' }] }, definition.steps[1]] }));
});

test('al correr el escenario envía cada video guardado; uno eliminado se omite', async () => {
  const parsed = scenarios.parseDefinition(definition);
  const original = { query: db.query, existing: conversations.queueExistingMedia, fresh: reuse.freshMediaId };
  const sent = [];
  db.query = async (sql) => {
    if (sql.includes('FROM conversation_scenario_states')) return { rows: [] };
    if (sql.includes('scenario_enabled FROM conversations')) return { rows: [{ scenario_enabled: true }] };
    if (sql.includes('FROM automation_scenarios')) return { rows: [{ id: 's1', key: 'bodega', isActive: true, ...parsed, position: 0 }] };
    return { rows: [] };
  };
  reuse.freshMediaId = async (_org, id) => { if (id === V2) throw Object.assign(new Error('Video no encontrado'), { status: 404 }); return `meta-${id.slice(0, 4)}`; };
  conversations.queueExistingMedia = async (...args) => { sent.push(args.slice(2)); return { id: 'm' }; };
  try {
    assert.deepEqual(await scenarios.processIncoming('org', 'conv', 'quiero ver la bodega'), { handled: true, requiresHuman: false });
    assert.deepEqual(sent, [['video', 'meta-1111', 'Así es nuestra bodega 📦']]);
  } finally { db.query = original.query; conversations.queueExistingMedia = original.existing; reuse.freshMediaId = original.fresh; }
});

test('el conector valida que el video guardado sea del negocio', async () => {
  const client = { query: async (sql) => ({ rows: sql.includes('FROM saved_videos') ? [{ id: V1, name: 'Recorrido', bytes: 100 }] : [] }) };
  const one = { ...definition, steps: [{ ...definition.steps[0], savedVideos: [{ videoId: V1 }] }, definition.steps[1]] };
  const validated = await mcp.validate('org', one, client);
  assert.equal(validated.steps[0].savedVideos[0].videoId, V1);
  await assert.rejects(mcp.validate('org', definition, client), /video guardado no existe/);
});
