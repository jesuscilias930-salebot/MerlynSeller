const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const messageService = require('../services/message.service');
const conversations = require('../services/conversation.service');
const reuse = require('../services/video-reuse.service');
const { isWhatsAppReady } = require('../services/video-conversion');

const HASH = 'a'.repeat(64);
const V = '11111111-1111-4111-8111-111111111111';

test('un video H.264 + AAC de menos de 16 MB no se recodifica', () => {
  const h264 = { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 1080, height: 1920 };
  assert.equal(isWhatsAppReady({ streams: [h264, { codec_type: 'audio', codec_name: 'aac' }] }, 9e6), true);
  assert.equal(isWhatsAppReady({ streams: [h264] }, 9e6), true, 'sin audio también');
  assert.equal(isWhatsAppReady({ streams: [{ ...h264, codec_name: 'hevc' }] }, 9e6), false, 'HEVC del iPhone se convierte');
  assert.equal(isWhatsAppReady({ streams: [h264, { codec_type: 'audio', codec_name: 'pcm_s16le' }] }, 9e6), false);
  assert.equal(isWhatsAppReady({ streams: [{ ...h264, pix_fmt: 'yuv422p10le' }] }, 9e6), false);
  assert.equal(isWhatsAppReady({ streams: [h264] }, 17 * 1024 * 1024), false, 'más de 16 MB se comprime');
  assert.equal(isWhatsAppReady(null, 1000), false);
});

test('mismo video: se reutiliza el archivo de Meta sin subirlo; si no hay, se pide subirlo', async () => {
  const original = { query: db.query, existing: conversations.queueExistingMedia };
  const calls = []; let cachedRow = [{ media_id: 'meta-123' }];
  db.query = async (sql, args) => { calls.push({ sql, args }); return { rows: sql.includes('FROM video_media_cache') ? cachedRow : [] }; };
  conversations.queueExistingMedia = async (...args) => ({ id: 'm1', status: 'pending', args });
  try {
    const hit = await reuse.queueCached('org', 'conv', { sha256: HASH.toUpperCase(), caption: 'Mira' });
    assert.equal(hit.cached, true); assert.deepEqual(hit.args, ['org', 'conv', 'video', 'meta-123', 'Mira']);
    assert.equal(calls[0].args[1], HASH, 'la huella se normaliza a minúsculas');
    assert.equal(calls[0].args[2], '25');
    cachedRow = [];
    assert.deepEqual(await reuse.queueCached('org', 'conv', { sha256: HASH }), { cached: false });
    await assert.rejects(reuse.queueCached('org', 'conv', { sha256: 'xyz' }), { status: 400 });
    await reuse.remember('org', HASH, 'meta-9', 1234);
    assert.match(calls.at(-1).sql, /ON CONFLICT \(organization_id, sha256\)/);
    await reuse.remember('org', 'malo', 'meta-9', 1);
    assert.match(calls.at(-1).sql, /INSERT INTO video_media_cache/, 'una huella inválida no se guarda');
    assert.equal(calls.filter((call) => call.sql.includes('INSERT INTO video_media_cache')).length, 1);
  } finally { db.query = original.query; conversations.queueExistingMedia = original.existing; }
});

test('video guardado: usa su archivo vigente o lo vuelve a subir si venció', async () => {
  const original = { query: db.query, upload: messageService.uploadMedia, existing: conversations.queueExistingMedia };
  let stale = false; const uploads = []; const updates = [];
  db.query = async (sql, args) => {
    if (sql.includes('AS stale')) return { rows: [{ id: V, media_id: 'meta-old', filename: 'promo.mp4', stale }] };
    if (sql.startsWith('SELECT file')) return { rows: [{ file: Buffer.from('mp4') }] };
    if (sql.startsWith('UPDATE saved_videos SET media_id')) { updates.push(args); return { rows: [] }; }
    return { rows: [] };
  };
  messageService.uploadMedia = async (media) => { uploads.push(media); return { mediaId: 'meta-new' }; };
  conversations.queueExistingMedia = async (...args) => ({ args });
  try {
    assert.equal((await reuse.queueSaved('org', 'conv', { videoId: V })).args[3], 'meta-old');
    assert.equal(uploads.length, 0);
    stale = true;
    assert.equal((await reuse.queueSaved('org', 'conv', { videoId: V, caption: 'Hola' })).args[3], 'meta-new');
    assert.equal(uploads[0].contentType, 'video/mp4'); assert.equal(uploads[0].buffer.toString(), 'mp4');
    assert.deepEqual(updates[0], [V, 'org', 'meta-new']);
    await assert.rejects(reuse.queueSaved('org', 'conv', { videoId: 'x' }), { status: 400 });
  } finally { db.query = original.query; messageService.uploadMedia = original.upload; conversations.queueExistingMedia = original.existing; }
});

test('guardar un video valida el nombre y conserva el MP4 listo', async () => {
  const original = { query: db.query, prepare: messageService.prepareVideo, upload: messageService.uploadMedia };
  let insert;
  messageService.prepareVideo = async () => ({ buffer: Buffer.alloc(10), contentType: 'video/mp4', filename: 'video.mp4' });
  messageService.uploadMedia = async () => ({ mediaId: 'meta-1' });
  db.query = async (sql, args) => { insert = args; return { rows: [{ id: V, name: args[1], filename: args[2], bytes: args[3], chat_shortcut: false, position: 0 }] }; };
  try {
    const saved = await reuse.create('org', { name: ' Bodega ', filename: 'IMG_1.MOV', contentType: 'video/quicktime', videoUploadPath: '/tmp/x' });
    assert.equal(saved.name, 'Bodega'); assert.equal(saved.bytes, 10); assert.equal(insert[5], 'meta-1');
    await assert.rejects(reuse.create('org', { name: '  ' }), { status: 400 });
  } finally { db.query = original.query; messageService.prepareVideo = original.prepare; messageService.uploadMedia = original.upload; }
});
