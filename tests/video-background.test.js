const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const queue = require('../lib/queue');
const realtime = require('../lib/realtime');
const jobs = [];
queue.outboundQueue = () => ({ add: async (...job) => { jobs.push(job); } });
const conversations = require('../services/conversation.service');
const messageService = require('../services/message.service');

const setup = (prepare) => {
  const original = { query: db.query, prepare: messageService.prepareVideo, upload: messageService.uploadMedia, publish: realtime.publish };
  const queries = [];
  db.query = async (sql, args) => { queries.push({ sql, args }); return sql.startsWith('INSERT INTO messages') || sql.startsWith('UPDATE messages SET media_id') ? { rows: [{ id: 'm1' }] } : { rows: [] }; };
  messageService.prepareVideo = prepare;
  messageService.uploadMedia = async () => ({ mediaId: 'meta-9' });
  realtime.publish = async () => {};
  jobs.length = 0;
  return { queries, restore: () => { db.query = original.query; messageService.prepareVideo = original.prepare; messageService.uploadMedia = original.upload; realtime.publish = original.publish; } };
};

test('el video se crea «processing» al recibirlo y se envía al terminar de prepararse', async () => {
  const { queries, restore } = setup(async () => ({ buffer: Buffer.from('mp4'), contentType: 'video/mp4', filename: 'video.mp4' }));
  try {
    const job = await conversations.queueVideoUpload('org', 'conv', { videoUploadPath: '/tmp/x', contentType: 'video/quicktime', filename: 'a.mov', caption: 'Mira' });
    assert.deepEqual(job.message, { id: 'm1', status: 'processing', type: 'video' });
    assert.match(queries[0].sql, /'processing'/); assert.equal(queries[0].args[2], 'Mira');
    assert.equal(jobs.length, 0, 'aún no se envía');
    await job.process();
    assert.ok(queries.some((query) => /SET media_id=\$2, status='pending'/.test(query.sql) && query.args[1] === 'meta-9'));
    assert.equal(jobs[0][0], 'send-video');
  } finally { restore(); }
});

test('si la preparación falla, el mensaje queda fallido con el motivo y no bloquea lo demás', async () => {
  const { queries, restore } = setup(async () => { throw Object.assign(new Error('El video convertido supera 16 MB. Recorta el video e intenta nuevamente.'), { status: 413 }); });
  try {
    const job = await conversations.queueVideoUpload('org', 'conv', { videoUploadPath: '/tmp/x', contentType: 'video/mp4', filename: 'a.mp4' });
    await job.process();
    const failed = queries.find((query) => /status='failed'/.test(query.sql));
    assert.match(failed.args[1], /16 MB/);
    assert.equal(jobs[0][0], 'drain-after-video'); assert.deepEqual(jobs[0][1], { conversationId: 'conv' });
  } finally { restore(); }
});
