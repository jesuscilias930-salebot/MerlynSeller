const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const chatAds = require('../services/chat-ad.service');

const IMG1 = '11111111-1111-4111-8111-111111111111';
const IMG2 = '22222222-2222-4222-8222-222222222222';
const CONV = '33333333-3333-4333-8333-333333333333';
const ad = (patch) => ({ id: 'a', name: 'Anuncio', isActive: true, position: 0, triggerExamples: ['Hola quiero información del paquete emprendedor'], buttons: [{ label: 'Modelos', imageIds: [IMG1] }], ...patch });

test('match: frases tolerantes, la más específica gana y los inactivos no cuentan', () => {
  const general = ad({ id: 'g', triggerExamples: ['hola quiero informacion'], position: 0 });
  const emprendedor = ad({ id: 'e', position: 1 });
  assert.equal(chatAds.match([general, emprendedor], '¡Hola! Quiero información del Paquete Emprendedor')?.id, 'e');
  assert.equal(chatAds.match([general, emprendedor], 'hola quiero informacion')?.id, 'g');
  assert.equal(chatAds.match([general, emprendedor], 'cuánto cuesta el envío a Puebla'), null);
  assert.equal(chatAds.match([{ ...emprendedor, isActive: false }], 'Hola quiero información del paquete emprendedor'), null);
  assert.equal(chatAds.match([emprendedor], ''), null);
});

test('guardar: valida botones e imágenes', async () => {
  const original = db.query;
  db.query = async (sql, args) => {
    if (sql.includes('FROM entrepreneur_package_images')) return { rows: args[1].filter((id) => id === IMG1).map((id) => ({ id })) };
    if (sql.includes('INSERT INTO chat_ads')) return { rows: [{ id: 'new', name: args[1], isActive: args[2], triggerExamples: JSON.parse(args[3]), buttons: JSON.parse(args[4]) }] };
    return { rows: [] };
  };
  try {
    const saved = await chatAds.create('org', { name: 'Calcetas', triggerExamples: ['hola', 'hola'], buttons: [{ label: 'Modelos', text: '  ', imageIds: [IMG1, IMG1] }] });
    assert.deepEqual(saved.triggerExamples, ['hola']);
    assert.deepEqual(saved.buttons, [{ label: 'Modelos', imageIds: [IMG1] }], 'quita texto vacío e imágenes repetidas');
    await assert.rejects(chatAds.create('org', { name: 'x', triggerExamples: ['hola'], buttons: [{ label: 'A', imageIds: [IMG2] }] }), /ya no existe/);
    await assert.rejects(chatAds.create('org', { name: 'x', triggerExamples: ['hola'], buttons: [] }), /al menos un botón/);
    await assert.rejects(chatAds.create('org', { name: 'x', triggerExamples: [], buttons: [{ label: 'A', imageIds: [IMG1] }] }), /al menos una frase/);
    await assert.rejects(chatAds.update('org', 'no-uuid', {}), (error) => error.status === 404);
  } finally { db.query = original; }
});

test('chat: usa el primer mensaje del cliente y omite imágenes borradas', async () => {
  const original = db.query;
  let first = '¡Hola! Quiero información del paquete emprendedor';
  db.query = async (sql, args) => {
    if (sql.includes('FROM messages')) return { rows: first ? [{ body: first }] : [] };
    if (sql.includes('FROM chat_ads')) return { rows: [ad({ buttons: [{ label: 'Modelos', text: 'Estos son', imageIds: [IMG1, IMG2] }, { label: 'Borrado', imageIds: [IMG2] }] })] };
    if (sql.includes('FROM entrepreneur_package_images')) return { rows: [{ id: IMG1 }] };
    return { rows: [] };
  };
  try {
    const { chatAd } = await chatAds.forConversation('org', CONV);
    assert.equal(chatAd.name, 'Anuncio');
    assert.deepEqual(chatAd.buttons, [{ label: 'Modelos', text: 'Estos son', imageIds: [IMG1] }]);
    first = 'otra cosa'; assert.deepEqual(await chatAds.forConversation('org', CONV), { chatAd: null });
    first = null; assert.deepEqual(await chatAds.forConversation('org', CONV), { chatAd: null });
    assert.deepEqual(await chatAds.forConversation('org', 'x'), { chatAd: null });
  } finally { db.query = original; }
});
