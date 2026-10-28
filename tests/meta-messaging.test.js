const test = require('node:test');
const assert = require('node:assert/strict');
const meta = require('../services/meta-messaging.service');

const env = { META_PAGE_ID: '111', META_PAGE_ACCESS_TOKEN: 'token', META_GRAPH_API_VERSION: 'v26.0', META_INSTAGRAM_ACCOUNT_ID: '222' };
const withEnv = async (run) => { const saved = {}; for (const [key, value] of Object.entries(env)) { saved[key] = process.env[key]; process.env[key] = value; } try { return await run(); } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } } };

test('convierte texto, fotos, respuestas rápidas y anuncios de Messenger al formato del inbox', () => {
  const [text, photo] = meta.normalizeEvent({ sender: { id: 'PSID' }, timestamp: 1, message: { mid: 'm1', text: 'Hola', reply_to: { mid: 'm0' }, attachments: [{ type: 'image', payload: { url: 'https://cdn/x.jpg' } }] } }, 'messenger');
  assert.deepEqual(text, { from: 'fb:PSID', timestamp: 1, context: { id: 'm0' }, id: 'm1', type: 'text', text: { body: 'Hola' } });
  assert.deepEqual(photo.image, { id: 'https://cdn/x.jpg' }); assert.equal(photo.id, 'm1:1');
  const [quick] = meta.normalizeEvent({ sender: { id: 'IG' }, message: { mid: 'm2', text: '500 pares', quick_reply: { payload: 'pares_500' } } }, 'instagram');
  assert.equal(quick.from, 'ig:IG'); assert.deepEqual(quick.interactive.button_reply, { id: 'pares_500', title: '500 pares' });
  const [ad] = meta.normalizeEvent({ sender: { id: 'P' }, message: { mid: 'm3', text: 'Info' }, referral: { source: 'ADS', ad_id: '99', ads_context_data: { ad_title: 'Mayoreo', photo_url: 'https://cdn/ad.jpg' } } }, 'messenger');
  assert.deepEqual(ad.referral, { source_id: '99', source_type: 'ad', headline: 'Mayoreo', image_url: 'https://cdn/ad.jpg', video_url: undefined, source_url: undefined, body: undefined });
  assert.deepEqual(meta.normalizeEvent({ sender: { id: 'P' }, message: { mid: 'e', text: 'eco', is_echo: true } }, 'messenger'), []);
  const [file] = meta.normalizeEvent({ sender: { id: 'P' }, message: { mid: 'm4', attachments: [{ type: 'file', payload: { url: 'https://cdn/a.pdf' } }] } }, 'messenger');
  assert.equal(file.type, 'document'); assert.equal(file.id, 'm4');
  const [reaction] = meta.normalizeEvent({ sender: { id: 'P' }, timestamp: 5, reaction: { mid: 'm1', action: 'react', emoji: '😍' } }, 'messenger');
  assert.deepEqual(reaction.reaction, { message_id: 'm1', emoji: '😍' });
});

test('ventana de envío: 24 h normal, 7 días por anuncio o como agente humano', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  const hoursAgo = (hours) => new Date(now - hours * 3600000).toISOString();
  assert.deepEqual(meta.sendWindow({ lastInboundAt: hoursAgo(2) }, now), { ok: true, messagingType: 'RESPONSE' });
  assert.deepEqual(meta.sendWindow({ lastInboundAt: hoursAgo(48), fromAd: true }, now), { ok: true, messagingType: 'RESPONSE' });
  assert.deepEqual(meta.sendWindow({ lastInboundAt: hoursAgo(48) }, now), { ok: true, messagingType: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' });
  assert.equal(meta.sendWindow({ lastInboundAt: hoursAgo(24 * 8) }, now).ok, false);
});

test('opciones se envían como respuestas rápidas; plantillas de WhatsApp se rechazan', () => {
  const body = JSON.stringify({ kind: 'options', body: '¿Cuántos pares?', options: [{ id: 'a', title: 'Menos de 100 pares de caricatura' }, { id: 'b', title: '500' }] });
  const message = meta.textMessage({ type: 'interactive', body });
  assert.equal(message.text, '¿Cuántos pares?');
  assert.deepEqual(message.quick_replies[1], { content_type: 'text', title: '500', payload: 'b' });
  assert.equal(message.quick_replies[0].title.length, 20);
  assert.throws(() => meta.textMessage({ type: 'template', body: '{}' }), /plantillas de WhatsApp/);
});

test('envía texto por la Send API de la página con respuesta a un mensaje', async () => {
  const original = global.fetch; const calls = [];
  global.fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ message_id: 'mid.1' }) }; };
  try {
    const result = await withEnv(() => meta.send({ channel: 'messenger', external_id: 'PSID', type: 'text', body: 'Hola', last_inbound_at: new Date().toISOString(), reply_to_provider_message_id: 'm0' }));
    assert.deepEqual(result, { accepted: true, messages: [{ id: 'mid.1' }] });
    assert.match(calls[0].url, /^https:\/\/graph\.facebook\.com\/v26\.0\/111\/messages\?access_token=token$/);
    assert.deepEqual(JSON.parse(calls[0].init.body), { recipient: { id: 'PSID' }, messaging_type: 'RESPONSE', message: { text: 'Hola' }, reply_to: { mid: 'm0' } });
    await assert.rejects(withEnv(() => meta.send({ channel: 'instagram', external_id: 'IG', type: 'document', media_id: 'x', last_inbound_at: new Date().toISOString() })), /Instagram no permite enviar documentos/);
  } finally { global.fetch = original; }
});

test('solo acepta la página o cuenta de Instagram configurada', async () => {
  const db = require('../lib/db'); const original = db.query;
  db.query = async () => ({ rows: [{ id: 'org-unica' }] });
  try {
    await withEnv(async () => {
      assert.equal(await meta.organizationFor('111'), 'org-unica');
      assert.equal(await meta.organizationFor('222'), 'org-unica');
      assert.equal(await meta.organizationFor('333'), null);
    });
  } finally { db.query = original; }
  assert.deepEqual(meta.statusUpdates({ sender: { id: 'P' }, delivery: { mids: ['a'] }, read: { watermark: 10 } }), [{ id: 'a', status: 'delivered' }, { watermark: 10, status: 'read', sender: 'P' }]);
});
