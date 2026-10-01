const { mkdtemp, rm } = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const MAX_VIDEO_UPLOAD_BYTES = 250 * 1024 * 1024;
const videoTypes = new Set(['video/mp4', 'video/3gpp', 'video/quicktime', 'video/x-m4v']);
let busy = false;

// Stream originals to a private temporary file, not a 250 MB request buffer.
exports.videoUpload = (handler) => async (req, res, next) => {
  if (!videoTypes.has((req.get('content-type') || '').split(';')[0].toLowerCase())) {
    return res.status(415).json({ error: 'Selecciona un video MP4, MOV, M4V o 3GPP.' });
  }
  if (Number(req.get('content-length')) > MAX_VIDEO_UPLOAD_BYTES) {
    return res.status(413).json({ error: 'El video no puede superar 250 MB.' });
  }
  if (busy) return res.status(429).json({ error: 'Hay un video subiendo o en preparación. Intenta nuevamente en unos momentos.' });
  busy = true;
  let directory;
  try {
    directory = await mkdtemp(join(tmpdir(), 'merlyn-upload-'));
    const path = join(directory, 'original.mov');
    let size = 0;
    const limit = new Transform({ transform(chunk, encoding, callback) {
      size += chunk.length;
      if (size > MAX_VIDEO_UPLOAD_BYTES) return callback(Object.assign(new Error('El video no puede superar 250 MB.'), { status: 413 }));
      callback(null, chunk);
    } });
    await pipeline(req, limit, createWriteStream(path, { mode: 0o600 }));
    if (!size) return res.status(400).json({ error: 'Selecciona un video válido.' });
    req.videoUploadPath = path;
    await handler(req, res, next);
  } catch (error) {
    if (!res.headersSent && !res.destroyed) {
      if (error.status) res.status(error.status).json({ error: error.message });
      else next(error);
    }
  } finally {
    try { if (directory) await rm(directory, { recursive: true, force: true }); }
    finally { busy = false; }
  }
};
exports.MAX_VIDEO_UPLOAD_BYTES = MAX_VIDEO_UPLOAD_BYTES;
