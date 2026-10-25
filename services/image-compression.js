const { spawn } = require('node:child_process');
const { mkdtemp, writeFile, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

// WhatsApp acepta imágenes de hasta 5 MB. Recibimos hasta 20 MB y, si hace falta,
// las reducimos a JPEG con ffmpeg (respeta la rotación del celular y pone fondo blanco a las transparencias).
const WHATSAPP_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_UPLOAD_BYTES = 20 * 1024 * 1024;
const ATTEMPTS = [[2560, 3], [2048, 4], [1600, 6], [1280, 9]];
const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const failure = (status, message) => Object.assign(new Error(message), { status });

const runFfmpeg = (args, timeoutMs = 60000) => new Promise((resolve, reject) => {
  const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  child.on('error', (error) => { clearTimeout(timer); reject(error); });
  child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(stderr || `ffmpeg terminó con ${code}`)); });
});

const jpegArgs = (input, output, side, quality) => ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-protocol_whitelist', 'file',
  '-i', input, '-f', 'lavfi', '-i', 'color=c=white',
  '-filter_complex', `[0:v]scale=w='min(${side},iw)':h='min(${side},ih)':force_original_aspect_ratio=decrease,format=rgba[fg];[1:v][fg]scale2ref[bg][fg2];[bg][fg2]overlay=format=auto:shortest=1,format=yuvj420p`,
  '-frames:v', '1', '-map_metadata', '-1', '-threads', '1', '-q:v', String(quality), output];

/** Devuelve la imagen lista para WhatsApp: igual si ya pesa 5 MB o menos; si no, un JPEG más ligero. */
exports.fitWhatsAppImage = async ({ buffer, contentType, filename }, run = runFfmpeg) => {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw failure(400, 'Selecciona una imagen válida.');
  if (buffer.length > MAX_IMAGE_UPLOAD_BYTES) throw failure(413, 'La imagen no puede superar 20 MB.');
  const type = String(contentType || '').split(';')[0].toLowerCase();
  if (!EXTENSIONS[type]) throw failure(415, 'Usa imágenes JPEG, PNG o WebP.');
  if (buffer.length <= WHATSAPP_IMAGE_MAX_BYTES) return { buffer, contentType: type, filename, compressed: false };
  let directory;
  try {
    directory = await mkdtemp(join(tmpdir(), 'merlyn-image-'));
    const input = join(directory, `input.${EXTENSIONS[type]}`);
    await writeFile(input, buffer, { mode: 0o600 });
    for (const [side, quality] of ATTEMPTS) {
      const output = join(directory, `output-${side}.jpg`);
      await run(jpegArgs(input, output, side, quality));
      const result = await readFile(output);
      if (result.length && result.length <= WHATSAPP_IMAGE_MAX_BYTES) {
        const base = String(filename || 'imagen').replace(/\.[^.]+$/, '') || 'imagen';
        return { buffer: result, contentType: 'image/jpeg', filename: `${base}.jpg`, compressed: true };
      }
    }
    throw failure(413, 'No se pudo reducir la imagen a 5 MB para WhatsApp. Usa una foto más ligera.');
  } catch (error) {
    if (error.status) throw error;
    console.error('No se pudo reducir la imagen', { reason: error.message?.slice(0, 300) });
    throw failure(422, 'No se pudo procesar la imagen. Intenta con otra foto en JPEG o PNG.');
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
};
exports.WHATSAPP_IMAGE_MAX_BYTES = WHATSAPP_IMAGE_MAX_BYTES;
exports.MAX_IMAGE_UPLOAD_BYTES = MAX_IMAGE_UPLOAD_BYTES;
