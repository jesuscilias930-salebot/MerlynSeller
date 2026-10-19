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
