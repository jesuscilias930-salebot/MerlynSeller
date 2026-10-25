const test = require('node:test');
const assert = require('node:assert/strict');
const { writeFile } = require('node:fs/promises');
const { fitWhatsAppImage, WHATSAPP_IMAGE_MAX_BYTES } = require('../services/image-compression');

test('las imágenes de hasta 5 MB pasan sin cambios', async () => {
  const buffer = Buffer.alloc(1000, 1);
  const result = await fitWhatsAppImage({ buffer, contentType: 'image/png', filename: 'a.png' }, () => { throw new Error('no debe convertir'); });
  assert.equal(result.buffer, buffer); assert.equal(result.compressed, false);
});

test('las imágenes grandes se reducen a JPEG probando tamaños más chicos', async () => {
  const sides = [];
  const run = async (args) => {
    const side = Number(args[args.indexOf('-filter_complex') + 1].match(/min\((\d+),iw\)/)[1]);
    sides.push(side);
    await writeFile(args.at(-1), Buffer.alloc(side > 2048 ? WHATSAPP_IMAGE_MAX_BYTES + 1 : 1000));
  };
  const result = await fitWhatsAppImage({ buffer: Buffer.alloc(WHATSAPP_IMAGE_MAX_BYTES + 10), contentType: 'image/jpeg', filename: 'foto.HEIC.jpeg' }, run);
  assert.deepEqual(sides, [2560, 2048]);
  assert.equal(result.contentType, 'image/jpeg'); assert.equal(result.filename, 'foto.HEIC.jpg'); assert.equal(result.compressed, true);
});

test('rechaza más de 20 MB, tipos no soportados y fallas de ffmpeg con mensajes claros', async () => {
  await assert.rejects(fitWhatsAppImage({ buffer: Buffer.alloc(20 * 1024 * 1024 + 1), contentType: 'image/png' }), { status: 413, message: 'La imagen no puede superar 20 MB.' });
  await assert.rejects(fitWhatsAppImage({ buffer: Buffer.alloc(10), contentType: 'image/gif' }), { status: 415 });
  await assert.rejects(fitWhatsAppImage({ buffer: Buffer.alloc(WHATSAPP_IMAGE_MAX_BYTES + 1), contentType: 'image/png' }, async () => { throw new Error('boom'); }), { status: 422 });
});
