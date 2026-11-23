const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');

test('video preparation converts to MP4, cleans files and reports failures', async t => {
  const original = childProcess.spawn;
  let inputPath;
  let argsSeen;
  let mode = 'ok';
  let failRemux = false;
  let probeResult = { streams: [{ codec_type: 'video', codec_name: 'hevc', pix_fmt: 'yuv420p10le', width: 1080, height: 1920 }] };
  childProcess.spawn = (command, args) => {
    if (command === 'ffprobe') {
      const probe = new EventEmitter();
      probe.stdout = new EventEmitter(); probe.kill = () => probe.emit('close', -1);
      setImmediate(() => { probe.stdout.emit('data', Buffer.from(JSON.stringify(probeResult))); probe.emit('close', 0); });
      return probe;
    }
    assert.equal(command, 'ffmpeg');
    argsSeen = args;
    inputPath = args[args.indexOf('-i') + 1];
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => child.emit('close', -1);
    setImmediate(async () => {
      if (mode === 'missing') return child.emit('error', Object.assign(new Error(), { code: 'ENOENT' }));
      if (mode === 'invalid' || (failRemux && args.includes('copy'))) return child.emit('close', 1);
      await fs.writeFile(args.at(-1), Buffer.from('converted-mp4'));
      child.emit('close', 0);
    });
    return child;
  };
  t.after(() => { childProcess.spawn = original; });
  const { prepareVideo } = require('../services/message.service');
  const input = { buffer: Buffer.from('mov-fixture'), contentType: 'video/quicktime', filename: 'IMG.MOV' };
  const result = await prepareVideo(input);
  assert.equal(result.contentType, 'video/mp4');
  assert.equal(result.filename, 'video.mp4');
  assert.equal(result.buffer.toString(), 'converted-mp4');
  assert.ok(argsSeen.includes('libx264'));
  assert.ok(argsSeen.includes('aac'));
  assert.equal(argsSeen[argsSeen.indexOf('-protocol_whitelist') + 1], 'file');
  await assert.rejects(fs.stat(inputPath), { code: 'ENOENT' });
  mode = 'invalid';
  await assert.rejects(prepareVideo(input), { status: 400 });
  await assert.rejects(fs.stat(inputPath), { code: 'ENOENT' });
  mode = 'missing';
  await assert.rejects(prepareVideo(input), { status: 503 });
  mode = 'ok';
  await assert.rejects(prepareVideo({ ...input, contentType: 'text/html' }), { status: 400 });
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const directory = await fs.mkdtemp(join(tmpdir(), 'video-test-'));
  const upload = join(directory, 'iphone.mov');
  try {
    await fs.writeFile(upload, '');
    await fs.truncate(upload, Math.ceil(180.8 * 1024 * 1024));
    const large = await prepareVideo({ ...input, buffer: undefined, videoUploadPath: upload });
    assert.equal(large.contentType, 'video/mp4');
    assert.equal(inputPath, upload);
    assert.ok(argsSeen.includes('1600k'));
    await fs.truncate(upload, 250 * 1024 * 1024 + 1);
    await assert.rejects(prepareVideo({ ...input, buffer: undefined, videoUploadPath: upload }), { status: 413 });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
  // Ya compatible con WhatsApp (H.264 + AAC, menos de 16 MB): solo se re-empaqueta, sin recodificar.
  probeResult = { streams: [{ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 720, height: 1280 }, { codec_type: 'audio', codec_name: 'aac' }] };
  const remuxed = await prepareVideo(input);
  assert.equal(remuxed.buffer.toString(), 'converted-mp4');
  assert.ok(argsSeen.includes('copy') && !argsSeen.includes('libx264'));
  // Si el re-empaquetado falla, se convierte normalmente.
  failRemux = true;
  await prepareVideo(input);
  assert.ok(argsSeen.includes('libx264'));
  failRemux = false;
  probeResult = { streams: [] };
  const first = prepareVideo(input);
  await assert.rejects(prepareVideo(input), { status: 429 });
  await first;
});
