const { spawn } = require('node:child_process');
const { mkdtemp, writeFile, readFile, stat, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const MAX_BYTES = 16 * 1024 * 1024;
let active = false;
const failure = (status, message) => Object.assign(new Error(message), { status });

// Files are seekable: iPhone MOVs may put their metadata after the video data.
exports.convertVideo = async (buffer) => {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw failure(400, 'Selecciona un video válido.');
  if (buffer.length > MAX_BYTES) throw failure(413, 'El video no puede superar 16 MB.');
  if (active) throw failure(429, 'Hay un video en preparación. Intenta nuevamente en unos momentos.');
  active = true;
  let directory;
  try {
    directory = await mkdtemp(join(tmpdir(), 'merlyn-video-'));
    const input = join(directory, 'input.mov');
    const output = join(directory, 'output.mp4');
    await writeFile(input, buffer, { mode: 0o600 });
    await new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error',
        '-protocol_whitelist', 'file', '-format_whitelist', 'mov', '-threads', '1', '-i', input,
        '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1', '-sn', '-dn',
        '-vf', "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
        '-filter_threads', '1', '-c:v', 'libx264', '-threads', '1', '-preset', 'veryfast', '-crf', '25',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-b:a', '96k',
        '-movflags', '+faststart', '-y', output], { stdio: ['ignore', 'ignore', 'ignore'] });
      let timedOut = false;
      let oversized = false;
      const sizeCheck = setInterval(() => {
        void stat(output).then(info => { if (info.size >= MAX_BYTES) { oversized = true; child.kill('SIGKILL'); } }).catch(() => {});
      }, 250);
      const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 90000);
      child.once('error', error => {
        clearTimeout(timeout);
        clearInterval(sizeCheck);
        reject(failure(503, error.code === 'ENOENT' ? 'La conversión de video no está disponible en el servidor.' : 'No fue posible preparar el video.'));
      });
      child.once('close', code => {
        clearTimeout(timeout);
        clearInterval(sizeCheck);
        if (oversized) return reject(failure(413, 'El video convertido supera 16 MB. Recorta el video e intenta nuevamente.'));
        if (timedOut) return reject(failure(422, 'El video tardó demasiado en prepararse. Intenta con un clip más corto.'));
        if (code !== 0) return reject(failure(400, 'No pudimos convertir el video. Verifica que el archivo esté completo.'));
        resolve();
      });
    });
    const size = (await stat(output)).size;
    if (!size || size >= MAX_BYTES) throw failure(413, 'El video convertido supera 16 MB. Recorta el video e intenta nuevamente.');
    return await readFile(output);
  } finally {
    try { if (directory) await rm(directory, { recursive: true, force: true }); }
    finally { active = false; }
  }
};
