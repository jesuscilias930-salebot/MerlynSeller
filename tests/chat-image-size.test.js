const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const queue = require('../lib/queue');
queue.outboundQueue = () => ({ add: async () => {} });
const conversations = require('../services/conversation.service');
const messageService = require('../services/message.service');
const compression = require('../services/image-compression');

test('la imagen del chat pasa por la reducción para WhatsApp antes de subirse', async () => {
  const original = { query: db.query, upload: messageService.uploadMedia, fit: compression.fitWhatsAppImage };
  const uploaded = [];
  db.query = async () => ({ rows: [{ id: 'm1' }] });
  messageService.uploadMedia = async (media) => { uploaded.push(media); return { mediaId: 'media-1' }; };
  compression.fitWhatsAppImage = async (input) => ({ buffer: Buffer.from('small'), contentType: 'image/jpeg', filename: input.filename.replace(/\.png$/, '.jpg'), compressed: true });
  try {
    await conversations.queueMedia('org', 'conv', 'image', { buffer: Buffer.alloc(12 * 1024 * 1024), contentType: 'image/png', filename: 'foto.png' });
    assert.equal(uploaded[0].filename, 'foto.jpg');
    assert.equal(uploaded[0].buffer.toString(), 'small');
  } finally { db.query = original.query; messageService.uploadMedia = original.upload; compression.fitWhatsAppImage = original.fit; }
});

test('más de 20 MB se rechaza con un mensaje claro', async () => {
  await assert.rejects(compression.fitWhatsAppImage({ buffer: Buffer.alloc(20 * 1024 * 1024 + 1), contentType: 'image/jpeg', filename: 'x.jpg' }), { status: 413, message: /20 MB/ });
});
