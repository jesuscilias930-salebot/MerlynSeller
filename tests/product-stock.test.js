const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const productStock = require('../services/product-stock.service');
const details = require('../services/product-detail.service');
const conversations = require('../services/conversation.service');
const messages = require('../services/message.service');

const control = [
  { id: 1, name: 'Caricatura niña', gender: 'Niña', size: '2-4', category: 'Caricatura', stock: 4, photos: [{ id: 11, url: 'https://s3/p1.png' }] },
  { id: 2, name: 'Caricatura niña', gender: 'Niña', size: '5-7', category: 'Caricatura', stock: 0, photos: [] },
  { id: 3, name: 'Caricatura niña', gender: 'Niña', size: '8-10', category: 'Caricatura', stock: 9, photos: [] },
  { id: 4, name: 'Playera básica', gender: 'Unisex', size: 'G', category: 'Ropa', stock: 2, photos: [] },
  { id: 5, name: 'Playera básica', gender: 'Unisex', size: 'CH', category: 'Ropa', stock: 6, photos: [] },
  { id: 6, name: 'Playera básica', gender: 'Unisex', size: 'M', category: 'Ropa', stock: 1, photos: [{ id: 66, url: 'https://s3/p6.png' }] },
  { id: 7, name: 'Playera básica', gender: 'Unisex', size: 'M', category: 'Ropa', stock: 3, photos: [] },
  { id: 8, name: 'Tobillera', gender: 'Mujer', size: '22-24', category: 'Básicos', stock: 0, photos: [{ id: 88, url: 'https://s3/p8.png' }] },
];
const env = { ...process.env };
const setup = (t, { cached = null } = {}) => {
  process.env.STORE_SHIPPING_SECRET = 'x'.repeat(32);
  process.env.SOCK_CONTROL_URL = 'https://control.test';
  delete process.env.STORE_ORGANIZATION_ID;
  productStock.clearCache();
  const original = { query: db.query, list: details.list, upload: messages.uploadMedia, queue: conversations.queueExistingMedia };
  const calls = { queries: [], uploads: 0, queued: [] };
  details.list = async () => [{ productId: 7, color: 'Negro', model: null }];
  db.query = async (sql, args) => { calls.queries.push(sql); return sql.includes('SELECT media_id') ? { rows: cached ? [{ media_id: cached }] : [] } : { rows: [] }; };
  messages.uploadMedia = async () => { calls.uploads += 1; return { mediaId: 'wa-media-1' }; };
  conversations.queueExistingMedia = async (...args) => { calls.queued.push(args); return { id: `m${calls.queued.length}` }; };
  t.after(() => { Object.assign(db, { query: original.query }); details.list = original.list; messages.uploadMedia = original.upload; conversations.queueExistingMedia = original.queue; process.env = { ...env }; productStock.clearCache(); });
  const fetcher = async (url) => {
    if (String(url).includes('/internal/crm/product-stock')) return { ok: true, json: async () => control };
    return { ok: true, headers: new Map([['content-type', 'image/png']]), arrayBuffer: async () => new ArrayBuffer(4) };
  };
  return { calls, fetcher };
};

test('las tallas se ordenan como se leen: CH, M, G y luego por número', () => {
  assert.deepEqual(['G', 'M', 'CH', 'XL'].sort(productStock.compareSizes), ['CH', 'M', 'G', 'XL']);
  assert.deepEqual(['22-24', '2-4', '8-10', '5-7'].sort(productStock.compareSizes), ['2-4', '5-7', '8-10', '22-24']);
  assert.equal(productStock.sizesText(['S', 'M', 'G']), 'Tallas disponibles: S, M, G');
  assert.equal(productStock.sizesText(['']), 'Disponible');
  assert.equal(productStock.sizesText([]), null);
});

test('familias: mismo modelo, color y género; solo tallas con existencia', () => {
  const families = productStock.families(control.map((item) => ({ ...item, color: item.id === 7 ? 'Negro' : null })));
  const nina = families.find((family) => family.title === 'Caricatura niña · Niña');
  assert.deepEqual(nina.sizes, ['2-4', '8-10']);
  assert.equal(nina.caption, 'Tallas disponibles: 2-4, 8-10');
  assert.equal(nina.productId, 1);
  const playera = families.find((family) => family.title === 'Playera básica · Unisex');
  assert.deepEqual(playera.sizes, ['CH', 'M', 'G']);
  assert.deepEqual(playera.photos, [{ id: 66, url: 'https://s3/p6.png' }]);
  assert.ok(families.some((family) => family.title === 'Playera básica · Negro · Unisex'), 'otro color es otra foto');
});

test('envía la foto del E-commerce con las tallas; la sube a WhatsApp una vez', async (t) => {
  const { calls, fetcher } = setup(t);
  const result = await productStock.queue('org', 'conv', [{ productId: 3, caption: '¡Nuevo modelo!' }], { fetcher });
  assert.deepEqual(result, { queued: 1, skipped: [] });
  assert.deepEqual(calls.queued[0], ['org', 'conv', 'image', 'wa-media-1', '¡Nuevo modelo!\nTallas disponibles: 2-4, 8-10']);
  assert.equal(calls.uploads, 1);
  assert.ok(calls.queries.some((sql) => sql.includes('INSERT INTO product_photo_media')));
});

test('reutiliza la foto ya subida y respeta la imagen propia', async (t) => {
  const { calls, fetcher } = setup(t, { cached: 'wa-cached' });
  await productStock.queue('org', 'conv', [{ productId: 1 }, { productId: 5, mediaId: 'mi-imagen' }], { fetcher });
  assert.equal(calls.uploads, 0);
  assert.deepEqual(calls.queued.map((args) => [args[3], args[4]]), [['wa-cached', 'Tallas disponibles: 2-4, 8-10'], ['mi-imagen', 'Tallas disponibles: CH, M, G']]);
});

test('omite lo agotado, lo que no tiene foto y lo que ya no existe', async (t) => {
  const { calls, fetcher } = setup(t);
  const result = await productStock.queue('org', 'conv', [{ productId: 8 }, { productId: 7 }, { productId: 99 }], { fetcher });
  assert.equal(result.queued, 0);
  assert.deepEqual(result.skipped, ['Tobillera · Mujer: agotado', 'Playera básica · Negro · Unisex: sin foto en el E-commerce', 'El producto ya no existe en Control de ventas']);
  assert.equal(calls.queued.length, 0);
});

test('solo la organización de la tienda consulta su inventario', async (t) => {
  const { fetcher } = setup(t);
  process.env.STORE_ORGANIZATION_ID = 'store-org';
  await assert.rejects(productStock.resolve('otra-org', { productId: 1 }, { fetcher }), { status: 403 });
});

test('sin secreto configurado avisa en lugar de consultar', async () => {
  const previous = process.env.STORE_SHIPPING_SECRET;
  process.env.STORE_SHIPPING_SECRET = '';
  productStock.clearCache();
  await assert.rejects(productStock.fetchStock({ fetcher: async () => { throw new Error('no'); } }), { status: 503 });
  process.env.STORE_SHIPPING_SECRET = previous;
});

test('el paso de imágenes acepta productos con tallas', () => {
  const scenarios = require('../services/scenario.service');
  const flow = scenarios.parseDefinition({ name: 'Modelos', triggerExamples: ['que modelos tienes'], steps: [
    { id: 'fotos', type: 'send_media', label: 'Modelos', products: [{ productId: 3, caption: 'Nuevo', label: 'Caricatura niña' }], nextStepId: 'fin' },
    { id: 'fin', type: 'end', label: 'Fin' },
  ] });
  assert.deepEqual(flow.steps[0].products, [{ productId: 3, caption: 'Nuevo', label: 'Caricatura niña' }]);
});
