const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const scenarios = require('../services/scenario.service');
const conversations = require('../services/conversation.service');
const mcp = require('../services/scenario-mcp.service');

const optionsStep = {
  id: 'paquetes', type: 'send_options', label: 'Elegir paquete', body: '¿Qué paquete te interesa?', buttonText: 'Ver paquetes',
  options: [
    { title: 'Caricatura 50 pares', description: '$446.50', nextStepId: 'gracias' },
    { title: 'Caricatura 100 pares', description: '$882', nextStepId: 'gracias' },
    { title: 'Caricatura 200 pares', description: '$1,728', nextStepId: 'gracias' },
    { title: 'Caricatura 500 pares', description: '$4,120', nextStepId: 'gracias' },
    { title: 'Deportivo Pro 450 pares', description: '$3,999', nextStepId: 'gracias' },
    { title: 'Ayúdame a elegir', nextStepId: 'asesor' },
  ],
};
const definition = {
  name: 'Paquetes', triggerExamples: ['quiero paquetes'], steps: [
    optionsStep,
    { id: 'gracias', type: 'send_text', label: 'Gracias', body: '¡Excelente elección!', nextStepId: 'fin' },
    { id: 'asesor', type: 'send_text', label: 'Asesor', body: 'Te ayudo a elegir.', nextStepId: 'fin' },
    { id: 'fin', type: 'end', label: 'Fin' },
  ],
};

test('el paso de opciones se valida con límites de WhatsApp y conserva destinos', () => {
  const parsed = scenarios.parseDefinition(definition);
  const step = parsed.steps[0];
  assert.equal(step.format, 'auto');
  assert.deepEqual(step.options[0], { id: 'caricatura_50_pares', title: 'Caricatura 50 pares', description: '$446.50', nextStepId: 'gracias' });
  assert.deepEqual(step.options[5], { id: 'ayudame_a_elegir', title: 'Ayúdame a elegir', nextStepId: 'asesor' });
  assert.deepEqual(scenarios.parseDefinition(parsed), parsed, 'volver a validar no cambia ids');
  assert.throws(() => scenarios.parseDefinition({ ...definition, steps: [{ ...optionsStep, options: [] }, ...definition.steps.slice(1)] }), /agrega al menos una opción/);
  assert.throws(() => scenarios.parseDefinition({ ...definition, steps: [{ ...optionsStep, format: 'buttons' }, ...definition.steps.slice(1)] }), /Paso 1 \(Elegir paquete\): Los botones permiten máximo 3/);
  assert.throws(() => scenarios.parseDefinition({ ...definition, steps: [{ ...optionsStep, options: [{ title: 'Uno', nextStepId: 'no_existe' }] }, ...definition.steps.slice(1)] }), /ya no existe \(no_existe\)/);
});

test('reconoce la opción por id, por texto exacto o por parecido sin empates', () => {
  const step = scenarios.parseDefinition(definition).steps[0];
  assert.equal(scenarios.optionForReply(step, 'algo', 'caricatura_500_pares').title, 'Caricatura 500 pares');
  assert.equal(scenarios.optionForReply(step, 'ayudame a elegir').id, 'ayudame_a_elegir');
  assert.equal(scenarios.optionForReply(step, 'el deportivo pro de 450').id, 'deportivo_pro_450_pares');
  assert.equal(scenarios.optionForReply(step, 'caricatura'), null);
  assert.equal(scenarios.optionForReply(step, 'hola buenas tardes'), null);
});

test('tocar una opción continúa el escenario en su paso de destino', async () => {
  const parsed = scenarios.parseDefinition(definition);
  const original = { query: db.query, queueText: conversations.queueText };
  const queries = []; const texts = [];
  db.query = async (sql, args) => {
    queries.push(sql);
    if (sql.includes('FROM conversation_scenario_states')) return { rows: [{ scenario_key: 'paquetes', step: 'paquetes' }] };
    if (sql.includes('scenario_enabled FROM conversations')) return { rows: [{ scenario_enabled: true }] };
    if (sql.includes('FROM automation_scenarios')) return { rows: [{ id: 's1', key: 'paquetes', isActive: true, ...parsed, position: 0 }] };
    return { rows: [] };
  };
  conversations.queueText = async (_org, _conv, input) => { texts.push(input.body); return { id: 'm' }; };
  try {
    assert.deepEqual(await scenarios.processOptionReply('org', 'conv', 'Ayúdame a elegir', 'ayudame_a_elegir'), { handled: true });
    assert.deepEqual(texts, ['Te ayudo a elegir.']);
    assert.ok(queries.some((sql) => sql.includes('SET completed_at=now()')), 'termina en el paso Fin');
    assert.deepEqual(await scenarios.processOptionReply('org', 'conv', 'no sé', undefined), { handled: false });
  } finally { db.query = original.query; conversations.queueText = original.queueText; }
});

test('MCP acepta opciones como ramas y no exige siguiente paso', async () => {
  const client = { query: async (sql) => ({ rows: sql.includes('lead_columns') ? [] : [] }) };
  const validated = await mcp.validate('org-1', definition, client);
  assert.equal(validated.steps[0].options.length, 6);
  await assert.rejects(mcp.validate('org-1', { ...definition, steps: [optionsStep, ...definition.steps.slice(1), { id: 'huerfano', type: 'end', label: 'Huérfano' }] }, client), /no está conectado/);
});

test('al iniciar, el paso envía el mensaje con opciones y queda esperando', async () => {
  const parsed = scenarios.parseDefinition(definition);
  const original = { query: db.query, queueOptions: conversations.queueOptions };
  const sent = []; let waiting;
  db.query = async (sql, args) => {
    if (sql.includes('FROM conversation_scenario_states')) return { rows: [] };
    if (sql.includes('scenario_enabled FROM conversations')) return { rows: [{ scenario_enabled: true }] };
    if (sql.includes('FROM automation_scenarios')) return { rows: [{ id: 's1', key: 'paquetes', isActive: true, ...parsed, position: 0 }] };
    if (sql.includes('INSERT INTO conversation_scenario_states')) waiting = args[3];
    return { rows: [] };
  };
  conversations.queueOptions = async (_org, _conv, message) => { sent.push(message); return { id: 'm' }; };
  try {
    assert.deepEqual(await scenarios.processIncoming('org', 'conv', 'quiero paquetes'), { handled: true, requiresHuman: false });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].buttonText, 'Ver paquetes');
    assert.equal(sent[0].options[3].id, 'caricatura_500_pares');
    assert.equal(sent[0].options[3].nextStepId, undefined, 'los destinos no se envían a WhatsApp');
    assert.equal(waiting, 'paquetes');
  } finally { db.query = original.query; conversations.queueOptions = original.queueOptions; }
});

test('una opción con cantidad de pares no se escala como cotización', async () => {
  const automations = require('../services/automation.service');
  const leads = require('../services/lead.service');
  const original = { query: db.query, option: scenarios.processOptionReply, attention: leads.moveToAttention };
  const calls = []; let escalated = false;
  db.query = async (sql) => sql.includes('auto_reply_enabled') ? { rows: [{ auto_reply_enabled: true }] } : { rows: [] };
  scenarios.processOptionReply = async (...args) => { calls.push(args); return { handled: true }; };
  leads.moveToAttention = async () => { escalated = true; return true; };
  try {
    await automations.processIncoming('org', 'conv', { id: 'wamid.1', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'caricatura_500_pares', title: 'Caricatura 500 pares' } } });
    assert.deepEqual(calls[0], ['org', 'conv', 'caricatura 500 pares', 'caricatura_500_pares']);
    calls.length = 0;
    await automations.processIncoming('org', 'conv', { id: 'wamid.2', type: 'text', text: { body: 'Caricatura 500 pares' } });
    assert.equal(calls[0][3], undefined);
    assert.equal(escalated, false);
  } finally { db.query = original.query; scenarios.processOptionReply = original.option; leads.moveToAttention = original.attention; }
});

test('los errores de validación indican paso y campo en español', () => {
  assert.throws(() => scenarios.parseDefinition({ ...definition, name: 'x' }), { status: 400, message: 'Nombre: necesita al menos 2 caracteres' });
  assert.throws(() => scenarios.parseDefinition({ ...definition, triggerExamples: [] }), { message: 'Frases que lo inician: agrega al menos uno' });
  const steps = [{ id: 'hola', type: 'send_text', label: 'Saludo', body: ' ', nextStepId: 'fin' }, { id: 'fin', type: 'end', label: 'Fin' }];
  assert.throws(() => scenarios.parseDefinition({ ...definition, steps }), { message: 'Paso 1 (Saludo): escribe el mensaje' });
  assert.throws(() => scenarios.parseDefinition({ ...definition, steps: [{ ...steps[1], label: '' }] }), { message: 'Paso 1 · Nombre del paso: no puede quedar vacío' });
});

test('una opción que lleva a «Esperar respuesta» se evalúa con sus respuestas', async () => {
  const flow = scenarios.parseDefinition({
    name: 'Paquetes', triggerExamples: ['quiero paquetes'], steps: [
      { id: 'menu', type: 'send_options', label: 'Menú', body: '¿Qué buscas?', options: [{ title: 'Precios', nextStepId: 'espera' }, { title: 'Hablar con asesor', nextStepId: 'espera' }] },
      { id: 'espera', type: 'wait_reply', label: 'Esperar', branches: [
        { id: 'precios', name: 'Precios', examples: ['precios', 'cuanto cuesta'], nextStepId: 'lista' },
        { id: 'asesor', name: 'Asesor', examples: ['hablar con asesor', 'asesor'], nextStepId: 'humano' },
      ] },
      { id: 'lista', type: 'send_text', label: 'Lista', body: 'Te paso la lista', nextStepId: 'fin' },
      { id: 'humano', type: 'send_text', label: 'Humano', body: 'Te atiende un asesor', nextStepId: 'fin' },
      { id: 'fin', type: 'end', label: 'Fin' },
    ],
  });
  const original = { query: db.query, queueText: conversations.queueText };
  const texts = []; let waitingAt = null;
  db.query = async (sql, args) => {
    if (sql.includes('FROM conversation_scenario_states')) return { rows: [{ scenario_key: 'paquetes', step: 'menu' }] };
    if (sql.includes('scenario_enabled FROM conversations')) return { rows: [{ scenario_enabled: true }] };
    if (sql.includes('FROM automation_scenarios')) return { rows: [{ id: 's1', key: 'paquetes', isActive: true, ...flow, position: 0 }] };
    if (sql.includes('INSERT INTO conversation_scenario_states')) waitingAt = args[3];
    return { rows: [] };
  };
  conversations.queueText = async (_o, _c, input) => { texts.push(input.body); return { id: 'm' }; };
  try {
    assert.deepEqual(await scenarios.processOptionReply('org', 'conv', 'hablar con asesor', 'hablar_con_asesor'), { handled: true });
    assert.deepEqual(texts, ['Te atiende un asesor'], 'no espera otro mensaje');
    assert.equal(waitingAt, null);
  } finally { db.query = original.query; conversations.queueText = original.queueText; }
});

test('la respuesta rápida de una plantilla inicia el escenario cuyas frases coinciden', async () => {
  const automations = require('../services/automation.service');
  const leads = require('../services/lead.service');
  const original = { query: db.query, option: scenarios.processOptionReply, incoming: scenarios.processIncoming, attention: leads.moveToAttention };
  const started = []; let escalated = false;
  db.query = async (sql) => sql.includes('auto_reply_enabled') ? { rows: [{ auto_reply_enabled: true }] } : sql.includes('INSERT INTO automation_events') ? { rows: [{ id: 'e1' }] } : { rows: [] };
  scenarios.processOptionReply = async () => ({ handled: false });
  scenarios.processIncoming = async (...args) => { started.push(args); return { handled: args[2].includes('catalogo') }; };
  leads.moveToAttention = async () => { escalated = true; return true; };
  try {
    await automations.processIncoming('org', 'conv', { id: 'wamid.3', type: 'button', button: { text: 'Sí, quiero ver el catalogo', payload: 'Sí, quiero ver el catalogo' } });
    assert.deepEqual(started[0], ['org', 'conv', 'si quiero ver el catalogo', { explicit: true }]);
    assert.equal(escalated, false);
    await automations.processIncoming('org', 'conv', { id: 'wamid.4', type: 'button', button: { text: 'No, gracias', payload: 'No, gracias' } });
    assert.equal(escalated, true, 'una respuesta sin escenario la atiende una persona');
  } finally { Object.assign(scenarios, { processOptionReply: original.option, processIncoming: original.incoming }); db.query = original.query; leads.moveToAttention = original.attention; }
});

test('un escenario viejo que ya no espera respuesta no bloquea el botón de la plantilla', async () => {
  const automations = require('../services/automation.service');
  const flow = scenarios.parseDefinition({ name: 'Catálogo por plantilla', triggerExamples: ['Sí, quiero ver el catálogo'], steps: [{ id: 'hola', type: 'send_text', label: 'Saludo', body: 'Aquí va', nextStepId: 'fin' }, { id: 'fin', type: 'end', label: 'Fin' }] });
  const catalogo = { ...flow, id: 's2', key: 'catalogo', isActive: true, canInterrupt: false, position: 1, priority: 0 };
  const calls = [];
  const original = { query: db.query, text: conversations.queueText, list: scenarios.list };
  db.query = async (sql, args) => {
    calls.push(sql);
    if (sql.includes('auto_reply_enabled')) return { rows: [{ auto_reply_enabled: true }] };
    if (sql.includes('scenario_enabled')) return { rows: [{ scenario_enabled: true }] };
    if (sql.includes('FROM conversation_scenario_states')) return { rows: [{ scenario_key: 'borrado', step: 'x' }] };
    return { rows: [] };
  };
  scenarios.list = async () => [catalogo];
  const sent = [];
  conversations.queueText = async (...args) => { sent.push(args[2].body); return {}; };
  try {
    await automations.processIncoming('org', 'conv', { id: 'wamid.9', type: 'button', button: { text: 'Sí, quiero ver el catálogo' } });
    assert.ok(calls.some((sql) => sql.includes('SET completed_at=now()')), 'cierra el escenario viejo');
    assert.deepEqual(sent, ['Aquí va']);
  } finally { db.query = original.query; conversations.queueText = original.text; scenarios.list = original.list; }
});

const scenarioRow = (key, position, triggerExamples, body) => ({
  ...scenarios.parseDefinition({ name: key, triggerExamples, steps: [{ id: 'hola', type: 'send_text', label: 'Saludo', body, nextStepId: 'fin' }, { id: 'fin', type: 'end', label: 'Fin' }] }),
  id: key, key, isActive: true, canInterrupt: false, position, priority: 0,
});
const withScenarioDb = async (rows, state, fn) => {
  const original = { query: db.query, text: conversations.queueText, list: scenarios.list };
  const sent = [];
  db.query = async (sql) => {
    if (sql.includes('auto_reply_enabled')) return { rows: [{ auto_reply_enabled: true }] };
    if (sql.includes('scenario_enabled')) return { rows: [{ scenario_enabled: true }] };
    if (sql.includes('FROM conversation_scenario_states')) return { rows: state ? [state] : [] };
    return { rows: [] };
  };
  scenarios.list = async () => rows;
  conversations.queueText = async (...args) => { sent.push(args[2].body); return {}; };
  try { await fn(sent); } finally { db.query = original.query; conversations.queueText = original.text; scenarios.list = original.list; }
};

test('gana la frase más específica aunque otro escenario esté más arriba', async () => {
  const rows = [scenarioRow('confirmar', 0, ['si', 'claro'], 'Confirmado'), scenarioRow('catalogo', 1, ['Sí, quiero ver el catálogo'], 'Aquí va el catálogo')];
  await withScenarioDb(rows, null, async (sent) => {
    await require('../services/automation.service').processIncoming('org', 'conv', { id: 'wamid.20', type: 'button', button: { text: 'Sí, quiero ver el catálogo' } });
    assert.deepEqual(sent, ['Aquí va el catálogo']);
  });
});

test('el botón de la plantilla reinicia el mismo escenario si el cliente se quedó esperando en él', async () => {
  const flow = scenarios.parseDefinition({ name: 'Catálogo', triggerExamples: ['Sí, quiero ver el catálogo'], steps: [
    { id: 'hola', type: 'send_text', label: 'Saludo', body: 'Aquí va el catálogo', nextStepId: 'espera' },
    { id: 'espera', type: 'wait_reply', label: 'Esperar', branches: [{ id: 'gracias', name: 'Gracias', examples: ['gracias'], nextStepId: 'fin' }] },
    { id: 'fin', type: 'end', label: 'Fin' },
  ] });
  const rows = [{ ...flow, id: 'c', key: 'catalogo', isActive: true, canInterrupt: false, position: 0, priority: 0 }];
  await withScenarioDb(rows, { scenario_key: 'catalogo', step: 'espera' }, async (sent) => {
    await require('../services/automation.service').processIncoming('org', 'conv', { id: 'wamid.21', type: 'button', button: { text: 'Sí, quiero ver el catálogo' } });
    assert.deepEqual(sent, ['Aquí va el catálogo']);
  });
});

test('sin escenario, el botón de la plantilla usa la automatización de catálogo y lo reenvía', async () => {
  const automations = require('../services/automation.service');
  const original = { query: db.query, doc: conversations.queueDocument, text: conversations.queueText, list: scenarios.list };
  const docs = []; const texts = [];
  db.query = async (sql) => {
    if (sql.includes('auto_reply_enabled')) return { rows: [{ auto_reply_enabled: true }] };
    if (sql.includes('FROM automation_intents') || sql.includes('FROM automations')) return { rows: [{ id: 'i1', key: 'catalogo', name: 'Catálogo', action: 'send_catalog', examples: ['quiero ver el catalogo'], isActive: true, priority: 0 }] };
    if (sql.includes('INSERT INTO automation_events')) return { rows: [{ id: 'e1' }] };
    if (sql.includes('FROM catalog_documents')) return { rows: [{ media_id: 'media1', filename: 'catalogo.pdf' }] };
    if (sql.includes('document') || sql.includes('catalog')) return { rows: [{ exists: true, sent: true, count: 1 }] };
    return { rows: [] };
  };
  scenarios.list = async () => [];
  conversations.queueDocument = async (...args) => { docs.push(args[2].mediaId); return {}; };
  conversations.queueText = async (...args) => { texts.push(args[2].body); return {}; };
  try {
    await automations.processIncoming('org', 'conv', { id: 'wamid.22', type: 'button', button: { text: 'Sí, quiero ver el catálogo' } });
    assert.deepEqual(docs, ['media1']);
    assert.deepEqual(texts, []);
  } finally { db.query = original.query; conversations.queueDocument = original.doc; conversations.queueText = original.text; scenarios.list = original.list; }
});

test('el botón de la plantilla reenvía el catálogo del escenario aunque el cliente ya lo tenga', async () => {
  const flow = scenarios.parseDefinition({ name: 'Catálogo', triggerExamples: ['Sí, quiero ver el catálogo'], steps: [
    { id: 'cat', type: 'send_catalog', label: 'Catálogo', nextStepId: 'fin' }, { id: 'fin', type: 'end', label: 'Fin' },
  ] });
  const rows = [{ ...flow, id: 'c', key: 'catalogo', isActive: true, canInterrupt: false, position: 0, priority: 0 }];
  const original = { query: db.query, doc: conversations.queueDocument, text: conversations.queueText, list: scenarios.list };
  const docs = []; const texts = [];
  db.query = async (sql) => {
    if (sql.includes('auto_reply_enabled')) return { rows: [{ auto_reply_enabled: true }] };
    if (sql.includes('scenario_enabled')) return { rows: [{ scenario_enabled: true }] };
    if (sql.includes('SELECT media_id,filename FROM catalog_documents')) return { rows: [{ media_id: 'media1', filename: 'catalogo.pdf' }] };
    if (sql.includes('AS sent')) return { rows: [{ sent: true }] };
    return { rows: [] };
  };
  scenarios.list = async () => rows;
  conversations.queueDocument = async (...args) => { docs.push(args[2].mediaId); return {}; };
  conversations.queueText = async (...args) => { texts.push(args[2].body); return {}; };
  try {
    await require('../services/automation.service').processIncoming('org', 'conv', { id: 'wamid.30', type: 'button', button: { text: 'Sí, quiero ver el catálogo' } });
    assert.deepEqual(docs, ['media1']);
    assert.deepEqual(texts, []);
    docs.length = 0;
    await scenarios.processIncoming('org', 'conv', 'si quiero ver el catalogo');
    assert.deepEqual(docs, [], 'escrito a mano respeta «ya está en la conversación»');
  } finally { db.query = original.query; conversations.queueDocument = original.doc; conversations.queueText = original.text; scenarios.list = original.list; }
});
