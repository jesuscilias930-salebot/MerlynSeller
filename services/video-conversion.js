const { spawn } = require('node:child_process');
const { mkdtemp, writeFile, readFile, stat, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const MAX_BYTES = 16 * 1024 * 1024;
const { MAX_VIDEO_UPLOAD_BYTES } = require('../middleware/video-upload.middleware');
let active = false;
const failure = (status, message) => Object.assign(new Error(message), { status });

const run = (command, args, { timeoutMs = 180000, output, maxBytes } = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  const chunks = [];
  child.stdout.on('data', chunk => { if (chunks.length < 2000) chunks.push(chunk); });
  let timedOut = false, oversized = false;
  const sizeCheck = output && maxBytes ? setInterval(() => {
    void stat(output).then(info => { if (info.size >= maxBytes) { oversized = true; child.kill('SIGKILL'); } }).catch(() => {});
  }, 250) : null;
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  const done = () => { clearTimeout(timeout); if (sizeCheck) clearInterval(sizeCheck); };
  child.once('error', error => { done(); reject(failure(503, error.code === 'ENOENT' ? 'La conversión de video no está disponible en el servidor.' : 'No fue posible preparar el video.')); });
  child.once('close', code => {
    done();
    if (oversized) return reject(failure(413, 'El video convertido supera 16 MB. Recorta el video e intenta nuevamente.'));
    if (timedOut) return reject(failure(422, 'El video tardó demasiado en prepararse. Intenta con un clip más corto.'));
    if (code !== 0) return reject(failure(400, 'No pudimos convertir el video. Verifica que el archivo esté completo.'));
    resolve(Buffer.concat(chunks).toString('utf8'));
  });
});

/** WhatsApp acepta H.264 + AAC (o sin audio) en MP4 de menos de 16 MB: esos solo se re-empaquetan (segundos), sin recodificar. */
exports.isWhatsAppReady = (probe, size) => {
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const video = streams.filter(stream => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1);
  const audio = streams.filter(stream => stream.codec_type === 'audio');
  return size > 0 && size < MAX_BYTES && video.length >= 1
    && video[0].codec_name === 'h264' && ['yuv420p', 'yuvj420p'].includes(video[0].pix_fmt)
    && Number(video[0].width) > 0 && Number(video[0].width) <= 4096 && Number(video[0].height) <= 4096
    && audio.every(stream => stream.codec_name === 'aac');
};

const probe = async (input) => {
  try {
    return JSON.parse(await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', 'mov', '-print_format', 'json', '-show_streams', input], { timeoutMs: 20000 }));
  } catch { return null; }
};

// Files are seekable: iPhone MOVs may put their metadata after the video data.
exports.convertVideo = async (buffer, uploadedPath) => {
  if (!uploadedPath && (!Buffer.isBuffer(buffer) || !buffer.length)) throw failure(400, 'Selecciona un video válido.');
  const inputSize = uploadedPath ? (await stat(uploadedPath)).size : buffer.length;
  if (inputSize > MAX_VIDEO_UPLOAD_BYTES) throw failure(413, 'El video no puede superar 250 MB.');
  if (active) throw failure(429, 'Hay un video en preparación. Intenta nuevamente en unos momentos.');
  active = true;
  let directory;
  try {
    directory = await mkdtemp(join(tmpdir(), 'merlyn-video-'));
    const input = uploadedPath || join(directory, 'input.mov');
    const output = join(directory, 'output.mp4');
    if (!uploadedPath) await writeFile(input, buffer, { mode: 0o600 });
    const ready = exports.isWhatsAppReady(await probe(input), inputSize);
    let mode = ready ? 'remux' : 'transcode';
    if (ready) {
      try {
        await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file', '-format_whitelist', 'mov', '-i', input,
          '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1', '-sn', '-dn', '-c', 'copy', '-movflags', '+faststart', '-y', output], { timeoutMs: 60000, output, maxBytes: MAX_BYTES });
      } catch { mode = 'transcode'; }
    }
    if (mode === 'transcode') {
      await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error',
        '-protocol_whitelist', 'file', '-format_whitelist', 'mov', '-threads', '1', '-i', input,
        '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1', '-sn', '-dn',
        '-vf', "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
        '-filter_threads', '1', '-c:v', 'libx264', '-threads', '1', '-preset', 'veryfast', '-crf', '25',
        '-maxrate', '1600k', '-bufsize', '3200k', '-r', '30',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-b:a', '96k',
        '-movflags', '+faststart', '-y', output], { output, maxBytes: MAX_BYTES });
    }
    console.log(JSON.stringify({ level: 'info', message: 'Video prepared for WhatsApp', mode, inputBytes: inputSize }));
    const size = (await stat(output)).size;
    if (!size || size >= MAX_BYTES) throw failure(413, 'El video convertido supera 16 MB. Recorta el video e intenta nuevamente.');
    return await readFile(output);
  } finally {
    try { if (directory) await rm(directory, { recursive: true, force: true }); }
    finally { active = false; }
  }
};
