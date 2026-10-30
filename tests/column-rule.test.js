const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const realtime = require('../lib/realtime');
const rules = require('../services/column-rule.service');
const leads = require('../services/lead.service');

const columnId = '22222222-2222-4222-8222-222222222222';
const rule = (patch = {}) => ({ id: 'r1', name: 'Mayoreo', phrases: ['precio de mayoreo', 'Distribuidor'], matchMode: 'contains', columnId, isActive: true, ...patch });

test('coincide por frase completa sin importar acentos, mayúsculas ni signos', () => {
  assert.equal(rules.matchRule([rule()], '¿Cuál es el PRECIO de mayoreo?')?.id, 'r1');
  assert.equal(rules.matchRule([rule()], 'quiero ser distribuidora'), null, 'no coincide con media palabra');
  assert.equal(rules.matchRule([rule({ matchMode: 'exact', phrases: ['Hola'] })], 'hola!')?.id, 'r1');
  assert.equal(rules.matchRule([rule({ matchMode: 'exact', phrases: ['Hola'] })], 'hola, precio'), null);
  assert.equal(rules.matchRule([rule({ isActive: false })], 'distribuidor'), null);
  assert.equal(rules.matchRule([rule({ id: 'a', phrases: ['precio'] }), rule({ id: 'b', phrases: ['precio'] })], 'precio')?.id, 'a', 'gana la primera');
});

test('lee el texto de mensajes, opciones y descripciones de fotos', () => {
  assert.equal(rules.messageText({ text: { body: 'hola' } }), 'hola');
  assert.equal(rules.messageText({ interactive: { list_reply: { title: '500 pares' } } }), '500 pares');
  assert.equal(rules.messageText({ image: { caption: 'este modelo' } }), 'este modelo');
  assert.equal(rules.messageText({ sticker: {} }), '');
});

test('valida la regla y quita frases repetidas', async () => {
  const original = db.query;
  const calls = [];
  db.query = async (sql, args) => { calls.push({ sql, args }); return { rows: [{ id: 'r1' }] }; };
  try {
    await rules.create('org', { name: ' Mayoreo ', phrases: ['Precio', ' precio ', 'mayoreo'], columnId });
    const insert = calls.find((call) => call.sql.includes('INSERT INTO column_rules'));
    assert.deepEqual(insert.args.slice(1, 5), ['Mayoreo', ['Precio', 'mayoreo'], 'contains', columnId]);
    await assert.rejects(rules.create('org', { name: 'x', phrases: [], columnId }), { status: 400, message: 'Agrega al menos una frase o una lada' });
    await assert.rejects(rules.create('org', { name: 'x', phrases: ['¿?'], columnId }), { message: 'Agrega al menos una frase con letras o números' });
  } finally { db.query = original; }
});

test('al coincidir mueve y fija el lead; las automatizaciones respetan el fijado', async () => {
  const original = { query: db.query, publish: realtime.publish };
  const calls = [];
  realtime.publish = async () => {};
  db.query = async (sql, args) => {
    calls.push({ sql, args });
    if (sql.includes('FROM column_rules')) return { rows: [rule()] };
    if (sql.includes('column_pinned_at IS NULL')) return { rows: [] };
    return { rows: [] };
  };
  try {
    const applied = await rules.applyIncoming('org', 'conv', { text: { body: 'Soy distribuidor' } });
    assert.equal(applied.id, 'r1');
    const update = calls.find((call) => call.sql.includes('column_pinned_at=now()'));
    assert.deepEqual(update.args, ['conv', 'org', columnId, 'r1']);
    assert.equal(await leads.autoMove('org', 'conv', 'otra'), false, 'un lead fijado no se mueve solo');
  } finally { db.query = original.query; realtime.publish = original.publish; }
});

test('segmenta por lada: solo números de esas ladas y la regla con lada va primero', () => {
  const general = rule({ id: 'general', phrases: ['catalogo'] });
  const orizaba = rule({ id: 'orizaba', phrases: ['catalogo'], areaCodes: ['272', '278'] });
  const cdmx = rule({ id: 'cdmx', phrases: [], areaCodes: ['55'] });
  const list = [general, orizaba, cdmx];
  assert.equal(rules.matchRule(list, 'quiero el catálogo', '5212721234567')?.id, 'orizaba', 'con 521');
  assert.equal(rules.matchRule(list, 'quiero el catálogo', '522781234567')?.id, 'orizaba', 'con 52');
  assert.equal(rules.matchRule(list, 'quiero el catálogo', '5213311112222')?.id, 'general', 'otra lada usa la regla general');
  assert.equal(rules.matchRule(list, 'hola', '5215512345678')?.id, 'cdmx', 'sin frases: cualquier mensaje de la lada');
  assert.equal(rules.matchRule(list, '', '5215512345678')?.id, 'cdmx', 'incluso una foto sin texto');
  assert.equal(rules.matchRule(list, 'hola', '5213311112222'), null);
  assert.equal(rules.matchRule(list, 'quiero el catálogo', 'fb:123456789')?.id, 'general', 'Messenger no tiene lada');
  assert.equal(rules.nationalNumber('+52 1 272 123 4567'), '2721234567');
});

test('valida y limpia las ladas', async () => {
  const original = db.query;
  const calls = [];
  db.query = async (sql, args) => { calls.push({ sql, args }); return { rows: [{ id: 'r1' }] }; };
  try {
    await rules.create('org', { name: 'Orizaba', phrases: [], areaCodes: ['272', ' (278) ', '272', ''], columnId });
    const insert = calls.find((call) => call.sql.includes('INSERT INTO column_rules'));
    assert.deepEqual(insert.args[6], ['272', '278']);
    await assert.rejects(rules.create('org', { name: 'x', areaCodes: ['2721234567'], columnId }), { status: 400, message: /no es una lada válida/ });
  } finally { db.query = original; }
});

test('aplica una regla por lada leyendo el teléfono del contacto', async () => {
  const original = { query: db.query, publish: realtime.publish };
  const calls = [];
  realtime.publish = async () => {};
  db.query = async (sql, args) => {
    calls.push({ sql, args });
    if (sql.includes('FROM column_rules')) return { rows: [rule({ id: 'orizaba', phrases: [], areaCodes: ['272'] })] };
    if (sql.includes('ct.phone_number')) return { rows: [{ phone_number: '5212721234567' }] };
    return { rows: [] };
  };
  try {
    const applied = await rules.applyIncoming('org', 'conv', { image: { id: 'img' } });
    assert.equal(applied.id, 'orizaba');
  } finally { db.query = original.query; realtime.publish = original.publish; }
});
