const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const queue = require('../lib/queue');
const jobs = [];
queue.outboundQueue = () => ({ add: async (...job) => { jobs.push(job); } });
const conversations = require('../services/conversation.service');
const location = require('../services/business-location.service');
const messageService = require('../services/message.service');
const meta = require('../services/meta-messaging.service');

test('valida coordenadas y arma el texto con enlace de Google Maps', () => {
  assert.deepEqual(location.parse({ latitude: '18.8512345678', longitude: -97.1 }), { latitude: 18.851235, longitude: -97.1, name: null, address: null });
  assert.throws(() => location.parse({ latitude: 95, longitude: 0 }), /latitud/);
  assert.throws(() => location.parse({ latitude: 'x', longitude: 0 }), { status: 400 });
  assert.equal(location.messageBody({ latitude: 18.85, longitude: -97.1, name: 'Bodega', address: 'Sur 5, Orizaba' }),
    '📍 Bodega\nSur 5, Orizaba\nhttps://www.google.com/maps/search/?api=1&query=18.85,-97.1');
});

test('envía la ubicación actual y la bodega guardada como mensaje de ubicación', async () => {
  const original = db.query; const inserts = [];
  db.query = async (sql, args) => {
    if (sql.includes('FROM business_locations')) return { rows: [{ name: 'Bodega Merlyn', address: 'Sur 5', latitude: '18.85', longitude: '-97.1', updated_at: new Date() }] };
    if (sql.includes('INSERT INTO messages')) { inserts.push(args); return { rows: [{ id: `m${inserts.length}` }] }; }
    return { rows: [] };
  };
  try {
    assert.deepEqual(await conversations.queueLocation('org', 'conv', { latitude: 19.4, longitude: -99.1 }), { id: 'm1', status: 'pending', type: 'location' });
    assert.deepEqual(JSON.parse(inserts[0][3]), { location: { latitude: 19.4, longitude: -99.1, name: null, address: null } });
    assert.match(inserts[0][2], /^📍 Ubicación\nhttps:\/\/www\.google\.com\/maps/);
    await conversations.queueLocation('org', 'conv', { source: 'saved' });
    assert.equal(JSON.parse(inserts[1][3]).location.name, 'Bodega Merlyn');
    assert.equal(JSON.parse(inserts[1][3]).location.latitude, 18.85);
    assert.equal(jobs.length, 2);
    db.query = async () => ({ rows: [] });
    await assert.rejects(conversations.queueLocation('org', 'conv', { source: 'saved' }), /Configuración/);
  } finally { db.query = original; }
});

test('WhatsApp recibe un pin y Messenger el texto con el enlace', async () => {
  const env = { ...process.env };
  Object.assign(process.env, { WHATSAPP_ACCESS_TOKEN: 'test', WHATSAPP_PHONE_NUMBER_ID: '123', WHATSAPP_GRAPH_API_VERSION: 'v21.0' });
  const original = global.fetch; let body;
  global.fetch = async (_url, init) => { body = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.1' }] }) }; };
  try {
    await messageService.sendLocation({ to: '522721234567', latitude: 18.85, longitude: -97.1, name: 'Bodega', address: null });
    assert.deepEqual(body.location, { latitude: 18.85, longitude: -97.1, name: 'Bodega' });
    assert.equal(body.type, 'location');
    await assert.rejects(messageService.sendLocation({ to: '522721234567', latitude: 100, longitude: 0 }), /coordenadas/);
  } finally { global.fetch = original; process.env = env; }
  assert.deepEqual(meta.textMessage({ type: 'location', body: '📍 Bodega\nhttps://maps' }), { text: '📍 Bodega\nhttps://maps' });
});
