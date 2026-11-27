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
    await assert.rejects(rules.create('org', { name: 'x', phrases: [], columnId }), { status: 400, message: 'Agrega al menos una frase, una lada o un anuncio' });
    await assert.rejects(rules.create('org', { name: 'x', phrases: ['¿?'], columnId }), { message: 'Agrega al menos una frase con letras o números' });
  } finally { db.query = original; }
});

test('al coincidir mueve el lead sin fijarlo; las automatizaciones lo pueden mover después', async () => {
  const original = { query: db.query, publish: realtime.publish };
  const calls = [];
  realtime.publish = async () => {};
  db.query = async (sql, args) => {
    calls.push({ sql, args });
    if (sql.includes('FROM column_rules')) return { rows: [rule()] };
    if (sql.includes('UPDATE conversations SET lead_column_id=$3, updated_at=now()')) return { rows: [{ id: 'conv' }] };
    return { rows: [] };
  };
  try {
    const applied = await rules.applyIncoming('org', 'conv', { text: { body: 'Soy distribuidor' } });
    assert.equal(applied.id, 'r1');
    const update = calls.find((call) => call.sql.includes('column_pinned_at=NULL'));
    assert.deepEqual(update.args, ['conv', 'org', columnId]);
    assert.ok(!calls.some((call) => call.sql.includes('column_pinned_at=now()')), 'no fija');
    assert.equal(await leads.autoMove('org', 'conv', 'otra'), true, 'una automatización lo puede mover');
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

test('por anuncio: el primer mensaje desde el anuncio mueve sin importar el texto, y va antes que las demás', () => {
  const byAd = rule({ id: 'anuncio120', phrases: [], adMatch: '120' });
  const general = rule({ id: 'general', phrases: ['donde se ubican'] });
  const referral = { source_id: '120211', headline: 'Caja Emprendedora 120 pares', body: '60 de caricatura y 60 económicos' };
  assert.equal(rules.matchRule([general, byAd], '¿Dónde se ubican?', null, referral)?.id, 'anuncio120', 'la de anuncio va primero');
  assert.equal(rules.matchRule([byAd], '😀', null, referral)?.id, 'anuncio120', 'cualquier mensaje');
  assert.equal(rules.matchRule([byAd], 'hola', null, null), null, 'sin anuncio no aplica');
  assert.equal(rules.matchRule([byAd], 'hola', null, { headline: 'Paquete 1200 pares' }), null, '«120» no coincide con «1200»');
  assert.equal(rules.matchRule([rule({ id: 'porId', phrases: [], adMatch: '120211' })], 'hola', null, referral)?.id, 'porId', 'por id del anuncio');
  assert.equal(rules.matchAd('caja emprendedora', { headline: 'Caja Emprendedora 120 pares' }), true);
  assert.equal(rules.matchAd('120', { sourceId: 'x', headline: 'Caja Emprendedora 120 pares' }), true, 'referral guardado (camelCase)');
});

test('mover a los que ya llegaron por el anuncio: cuenta, mueve y respeta Descartados', async () => {
  const original = { query: db.query, publish: realtime.publish };
  realtime.publish = async () => {};
  const calls = [];
  db.query = async (sql, args) => {
    calls.push({ sql, args });
    if (sql.includes('FROM column_rules rule')) return { rows: [{ ...rule({ id: 'r', phrases: [], adMatch: '120' }), columnId }] };
    if (sql.includes('SELECT DISTINCT ON (m.conversation_id)')) return { rows: [
      { conversation_id: 'a', referral: { headline: 'Caja 120 pares' } },
      { conversation_id: 'b', referral: { headline: 'Hoodies Essentials' } },
    ] };
    if (sql.startsWith('UPDATE conversations')) return { rowCount: args[1].length, rows: args[1].map((id) => ({ id })) };
    return { rows: [] };
  };
  try {
    const id = '33333333-3333-4333-8333-333333333333';
    assert.deepEqual(await rules.backfill('org', id, { dryRun: true }), { count: 1, moved: 0 });
    assert.ok(calls.some((call) => call.sql.includes("NOT LIKE '%descartad%'")));
    assert.deepEqual(await rules.backfill('org', id, { dryRun: false }), { count: 1, moved: 1 });
    assert.deepEqual(calls.find((call) => call.sql.startsWith('UPDATE conversations')).args[1], ['a']);
  } finally { db.query = original.query; realtime.publish = original.publish; }
});
