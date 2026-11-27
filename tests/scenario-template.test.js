const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const conversations = require('../services/conversation.service');
const scenarios = require('../services/scenario.service');
const automations = require('../services/automation.service');

const TPL = '11111111-1111-4111-8111-111111111111';
const OTHER_TPL = '22222222-2222-4222-8222-222222222222';
const steps = (body) => [{ id: 'hola', type: 'send_text', label: 'Saludo', body, nextStepId: 'fin' }, { id: 'fin', type: 'end', label: 'Fin' }];
const row = (key, position, triggerExamples, body, templateTrigger) => ({
  ...scenarios.parseDefinition({ name: key, triggerExamples, steps: steps(body), ...(templateTrigger ? { templateTrigger } : {}) }),
  id: key, key, isActive: true, canInterrupt: true, position, priority: 0, templateTrigger: templateTrigger || null,
});
const trigger = (templateId = TPL) => ({ templateId, templateName: 'remarketing_cotizacion_caja_120' });

test('validación: escenario de plantilla puede no tener frases; uno normal sí las necesita', () => {
  const parsed = scenarios.parseDefinition({ name: 'Caja 120 sí', triggerExamples: [], steps: steps('Va'), templateTrigger: trigger() });
  assert.deepEqual(parsed.triggerExamples, []);
  assert.equal(parsed.templateTrigger.templateId, TPL);
  assert.throws(() => scenarios.parseDefinition({ name: 'Normal', triggerExamples: [], steps: steps('Va') }), /Frases que lo inician/);
  assert.throws(() => scenarios.parseDefinition({ name: 'Malo', triggerExamples: [], steps: steps('Va'), templateTrigger: { templateId: 'x', templateName: 'a' } }));
});

const withDb = async ({ rows, previous, replied, state = null }, fn) => {
  const original = { query: db.query, text: conversations.queueText, list: scenarios.list };
  const sent = []; const calls = [];
  db.query = async (sql) => {
    calls.push(sql);
    if (sql.includes('auto_reply_enabled')) return { rows: [{ auto_reply_enabled: true }] };
    if (sql.includes('scenario_enabled')) return { rows: [{ scenario_enabled: true }] };
    if (sql.includes('FROM conversation_scenario_states')) return { rows: state ? [state] : [] };
    if (sql.includes('provider_message_id=$3 AND direction=\'outbound\'')) return { rows: replied ? [replied] : [] };
    if (sql.includes('JOIN messages inbound')) return { rows: previous ? [previous] : [] };
    return { rows: [] };
  };
  scenarios.list = async () => rows;
  conversations.queueText = async (...args) => { sent.push(args[2].body); return {}; };
  try { await fn(sent, calls); } finally { db.query = original.query; conversations.queueText = original.text; scenarios.list = original.list; }
};
const templateRow = (templateId = TPL, extra = {}) => ({ id: 'm1', direction: 'outbound', type: 'template', status: 'sent', created_at: new Date().toISOString(), body: JSON.stringify({ templateName: 'x', templateId }), ...extra });

test('botón de la plantilla: inicia solo el escenario de esa plantilla, aunque otro escenario normal coincida', async () => {
  const rows = [
    row('si_general', 0, ['si', 'sí, la quiero'], 'Escenario normal'),
    row('caja_si', 1, ['Sí, la quiero'], 'Apartamos tu caja', trigger()),
    row('caja_duda', 2, ['Tengo una duda'], 'Dime tu duda', trigger()),
    row('otra_plantilla', 3, ['Sí, la quiero'], 'Otra plantilla', trigger(OTHER_TPL)),
  ];
  await withDb({ rows, replied: templateRow() }, async (sent) => {
    await automations.processIncoming('org', 'conv', { id: 'wamid.1', type: 'button', button: { text: 'Sí, la quiero' }, context: { id: 'wamid.tpl' } });
    assert.deepEqual(sent, ['Apartamos tu caja']);
  });
  await withDb({ rows, replied: templateRow() }, async (sent) => {
    await automations.processIncoming('org', 'conv', { id: 'wamid.2', type: 'button', button: { text: 'Tengo una duda' }, context: { id: 'wamid.tpl' } });
    assert.deepEqual(sent, ['Dime tu duda']);
  });
});

test('texto escrito justo después de la plantilla también cuenta como respuesta a la plantilla', async () => {
  const rows = [row('si_general', 0, ['si'], 'Escenario normal'), row('caja_cualquiera', 1, [], 'Te ayudo con tu caja', trigger())];
  await withDb({ rows, previous: templateRow() }, async (sent) => {
    await automations.processIncoming('org', 'conv', { id: 'wamid.3', type: 'text', text: { body: 'si' } });
    assert.deepEqual(sent, ['Te ayudo con tu caja'], 'sin frases = cualquier respuesta a la plantilla');
  });
});

test('respuesta a plantilla sin escenario de plantilla: no inicia escenarios normales (la atiende una persona)', async () => {
  const rows = [row('si_general', 0, ['si', 'sí, la quiero'], 'Escenario normal')];
  await withDb({ rows, replied: templateRow() }, async (sent) => {
    await automations.processIncoming('org', 'conv', { id: 'wamid.4', type: 'button', button: { text: 'Sí, la quiero' }, context: { id: 'wamid.tpl' } });
    assert.deepEqual(sent, []);
  });
});

test('mensajes normales no inician escenarios de plantilla, pero uno ya en curso continúa', async () => {
  const rows = [row('caja_si', 0, ['hola'], 'De plantilla', trigger()), row('saludo', 1, ['hola'], 'Hola normal')];
  await withDb({ rows, previous: { id: 'm0', direction: 'inbound', type: 'text', body: 'x', status: 'received', created_at: new Date().toISOString() } }, async (sent) => {
    await automations.processIncoming('org', 'conv', { id: 'wamid.5', type: 'text', text: { body: 'hola' } });
    assert.deepEqual(sent, ['Hola normal']);
  });
});

test('plantilla vieja (más de 7 días) o fallida no cuenta como respuesta', async () => {
  const old = templateRow(TPL, { created_at: new Date(Date.now() - 8 * 86400000).toISOString() });
  await withDb({ rows: [], previous: old }, async () => {
    assert.equal(await scenarios.templateReplyContext('org', 'conv', { id: 'wamid.6' }), null);
  });
  await withDb({ rows: [], previous: templateRow(TPL, { status: 'failed' }) }, async () => {
    assert.equal(await scenarios.templateReplyContext('org', 'conv', { id: 'wamid.7' }), null);
  });
  await withDb({ rows: [], previous: templateRow() }, async () => {
    assert.deepEqual(await scenarios.templateReplyContext('org', 'conv', { id: 'wamid.8' }), { templateId: TPL, messageId: 'm1' });
  });
});

test('campaña: se recorta, vacío = sin campaña y omitirla la conserva', () => {
  const base = { name: 'CE120 · Envío', triggerExamples: ['envio'], steps: steps('Va') };
  assert.equal(scenarios.parseDefinition({ ...base, campaign: '  Campaña 120 ' }).campaign, 'Campaña 120');
  assert.equal(scenarios.parseDefinition({ ...base, campaign: '   ' }).campaign, null);
  assert.equal(scenarios.parseDefinition(base).campaign, undefined);
  assert.throws(() => scenarios.parseDefinition({ ...base, campaign: 'x'.repeat(61) }));
});

test('si un escenario de plantilla atendió la respuesta, processIncoming lo reporta (el remarketing no mueve)', async () => {
  const rows = [row('caja_si', 0, ['Sí, la quiero'], 'Apartamos tu caja', trigger())];
  await withDb({ rows, replied: templateRow() }, async () => {
    const handled = await automations.processIncoming('org', 'conv', { id: 'wamid.9', type: 'button', button: { text: 'Sí, la quiero' }, context: { id: 'wamid.tpl' } });
    assert.deepEqual(handled, { templateScenario: true });
  });
  await withDb({ rows: [], replied: templateRow() }, async () => {
    const handled = await automations.processIncoming('org', 'conv', { id: 'wamid.10', type: 'button', button: { text: 'Otra cosa' }, context: { id: 'wamid.tpl' } });
    assert.deepEqual(handled, { templateScenario: false });
  });
});

test('dashboard del escenario: uuid opcional; omitirlo lo conserva', () => {
  const base = { name: 'CE120 · Envío', triggerExamples: ['envio'], steps: steps('Va') };
  assert.equal(scenarios.parseDefinition({ ...base, boardId: TPL }).boardId, TPL);
  assert.equal(scenarios.parseDefinition({ ...base, boardId: null }).boardId, null);
  assert.equal(scenarios.parseDefinition(base).boardId, undefined);
  assert.throws(() => scenarios.parseDefinition({ ...base, boardId: 'x' }));
});
