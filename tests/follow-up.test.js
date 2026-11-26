const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const followUps = require('../services/follow-up.service');
const conversations = require('../services/conversation.service');
const leads = require('../services/lead.service');
const businessHours = require('../services/business-hours.service');

const at = (iso) => new Date(iso);
// 18:00 UTC = 12:00 en Ciudad de México.
const NOON = at('2026-11-24T18:00:00Z');
const step = { waitMinutes: 60, text: 'Hola, ¿pudiste ver la caja?', imageIds: [] };

test('decide: espera, ventana de 24 h, anuncio (72 h), plantilla y horario nocturno', () => {
  const base = { step, lastOutAt: '2026-11-24T17:30:00Z', lastInAt: '2026-11-24T17:00:00Z', now: NOON };
  assert.equal(followUps.decide(base).action, 'wait');
  assert.equal(followUps.decide({ ...base, lastOutAt: '2026-11-24T16:00:00Z' }).action, 'send');
  assert.equal(followUps.decide({ ...base, lastOutAt: '2026-11-24T16:00:00Z', outboundQueued: true }).reason, 'queued');
  const old = { ...base, lastOutAt: '2026-11-22T16:00:00Z', lastInAt: '2026-11-22T15:00:00Z' };
  assert.equal(followUps.decide(old).action, 'stop', 'pasaron 24 h y no hay plantilla');
  assert.equal(followUps.decide({ ...old, fromAd: true }).action, 'stop', 'anuncio: las 72 h solo hacen gratis las plantillas; texto libre sigue siendo 24 h');
  assert.equal(followUps.decide({ ...old, fromAd: true, step: { ...step, templateId: 't1' } }).action, 'template');
  assert.equal(followUps.decide({ ...old, step: { ...step, templateId: 't1' } }).action, 'template');
  assert.equal(followUps.decide({ ...old, channel: 'messenger', step: { ...step, templateId: 't1' } }).action, 'stop');
  assert.equal(followUps.decide({ ...base, lastOutAt: '2026-11-24T02:00:00Z', now: at('2026-11-24T05:00:00Z') }).reason, 'quiet_hours', '23:00 en México');
  assert.equal(followUps.decide({ ...base, step: undefined }).action, 'complete');
});

test('guardar: valida pasos, plantilla y columna', async () => {
  const original = db.query; const calls = [];
  db.query = async (sql, args) => {
    calls.push(sql);
    if (sql.includes('FROM lead_columns')) return { rows: args[1].filter((id) => id !== 'x').map((id) => ({ id })) };
    if (sql.includes('FROM whatsapp_templates')) return { rows: [{ name: 'Seguimiento', status: 'APPROVED', variable_mappings: args[0] === '33333333-3333-4333-8333-333333333333' ? [{ source: 'manual' }] : [{ source: 'contact.name' }] }] };
    if (sql.includes('INSERT INTO follow_up_sequences')) return { rows: [{ id: 's1', column_id: args[1], is_active: args[2], steps: JSON.parse(args[3]), final_column_id: args[4] }] };
    return { rows: [] };
  };
  const COL = '11111111-1111-4111-8111-111111111111', FINAL = '22222222-2222-4222-8222-222222222222';
  try {
    const saved = await followUps.save('org', COL, { isActive: true, steps: [{ waitMinutes: 120, text: 'Hola' }, { waitMinutes: 1440, templateId: '44444444-4444-4444-8444-444444444444' }], finalColumnId: FINAL });
    assert.equal(saved.steps.length, 2); assert.equal(saved.finalColumnId, FINAL);
    await assert.rejects(followUps.save('org', COL, { steps: [{ waitMinutes: 10, text: 'x' }] }), /Paso 1: La espera mínima/);
    await assert.rejects(followUps.save('org', COL, { steps: [{ waitMinutes: 60 }] }), /necesita un mensaje/);
    await assert.rejects(followUps.save('org', COL, { steps: Array(4).fill({ waitMinutes: 60, text: 'x' }) }), /Hasta 3 pasos/);
    await assert.rejects(followUps.save('org', COL, { steps: [{ waitMinutes: 60, templateId: '33333333-3333-4333-8333-333333333333' }] }), /valores escritos a mano/);
    await assert.rejects(followUps.save('org', COL, { steps: [{ waitMinutes: 60, text: 'x' }], finalColumnId: COL }), /distinta/);
  } finally { db.query = original; }
});

test('run: envía el paso que toca, una sola vez, y al terminar mueve el lead', async () => {
  const original = { query: db.query, text: conversations.queueText, template: conversations.queueTemplate, move: leads.autoMove, hours: businessHours.get };
  const sent = []; const moved = []; let stepIndex = 0;
  const candidate = (overrides = {}) => ({ conversation_id: 'c1', organization_id: 'org', sequence_id: 's1', steps: [step, { waitMinutes: 1440, templateId: 't1' }], final_column_id: 'cold', channel: 'whatsapp', last_out_at: '2026-11-24T16:00:00Z', last_in_at: '2026-11-24T15:00:00Z', from_ad: false, outbound_queued: false, state_sequence_id: 's1', cycle_inbound_at: '2026-11-24T15:00:00Z', step_index: stepIndex, state_status: 'active', ...overrides });
  let rows = [];
  db.query = async (sql) => {
    if (sql.includes('FROM follow_up_sequences s')) return { rows };
    if (sql.includes('SET step_index=step_index+1')) { stepIndex += 1; return { rows: [{ step_index: stepIndex }] }; }
    return { rows: [] };
  };
  conversations.queueText = async (_o, conv, input) => { sent.push(['text', conv, input.body]); };
  conversations.queueTemplate = async (_o, conv, input) => { sent.push(['template', conv, input.templateId]); };
  leads.autoMove = async (...args) => { moved.push(args); return true; };
  businessHours.get = async () => ({ timezone: 'America/Mexico_City' });
  try {
    rows = [candidate()];
    assert.deepEqual(await followUps.run(NOON), { sent: 1 });
    assert.deepEqual(sent[0], ['text', 'c1', step.text]);
    // Paso 2 (plantilla) al día siguiente, ya fuera de las 24 h: se envía la plantilla y se mueve el lead.
    rows = [candidate({ step_index: 1, last_out_at: '2026-11-24T18:00:00Z' })];
    await followUps.run(at('2026-11-25T19:00:00Z'));
    assert.deepEqual(sent[1], ['template', 'c1', 't1']);
    assert.deepEqual(moved[0], ['org', 'c1', 'cold']);
  } finally { db.query = original.query; conversations.queueText = original.text; conversations.queueTemplate = original.template; leads.autoMove = original.move; businessHours.get = original.hours; }
});

test('run: si el cliente escribió (nuevo ciclo) se reinicia desde el paso 1', async () => {
  const original = { query: db.query, text: conversations.queueText, hours: businessHours.get };
  const queries = []; const sent = [];
  db.query = async (sql, args) => {
    queries.push({ sql, args });
    if (sql.includes('FROM follow_up_sequences s')) return { rows: [{ conversation_id: 'c1', organization_id: 'org', sequence_id: 's1', steps: [step], final_column_id: null, channel: 'whatsapp', last_out_at: '2026-11-24T16:00:00Z', last_in_at: '2026-11-24T15:30:00Z', from_ad: false, outbound_queued: false, state_sequence_id: 's1', cycle_inbound_at: '2026-11-23T10:00:00Z', step_index: 1, state_status: 'completed' }] };
    if (sql.includes('SET step_index=step_index+1')) return { rows: [{ step_index: 1 }] };
    return { rows: [] };
  };
  conversations.queueText = async (_o, conv, input) => { sent.push(input.body); };
  businessHours.get = async () => ({ timezone: 'America/Mexico_City' });
  try {
    await followUps.run(NOON);
    assert.ok(queries.some((query) => query.sql.includes('INSERT INTO conversation_follow_ups') && query.args[3] === '2026-11-24T15:30:00.000Z'));
    assert.deepEqual(sent, [step.text]);
  } finally { db.query = original.query; conversations.queueText = original.text; businessHours.get = original.hours; }
});
