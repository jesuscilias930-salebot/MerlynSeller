const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const controller = require('../controllers/settings.controller');

const pkg = '11111111-1111-4111-8111-111111111111';
const [a, b, c] = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'];
const response = () => { const res = { statusCode: 200, body: undefined, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, end() { return this; } }; return res; };
const withClient = async (query, run) => {
  const original = db.transaction; db.transaction = (fn) => fn({ query });
  try { return await run(); } finally { db.transaction = original; }
};

test('guarda el orden de envío y actualiza la portada', async () => {
  const calls = [];
  const query = async (sql, args) => { calls.push({ sql, args }); if (sql.startsWith('SELECT id FROM entrepreneur_packages')) return { rows: [{ id: pkg }] }; if (sql.startsWith('SELECT id FROM entrepreneur_package_images')) return { rows: [{ id: a }, { id: b }, { id: c }] }; return { rows: [] }; };
  const res = response();
  await withClient(query, () => controller.reorderEntrepreneurPackageImages({ params: { id: pkg }, body: { imageIds: [c, a, b] }, auth: { organizationId: 'org' } }, res, assert.fail));
  assert.equal(res.statusCode, 204);
  assert.deepEqual(calls.find((call) => call.sql.includes('WITH ORDINALITY')).args, [pkg, [c, a, b]]);
  assert.ok(calls.some((call) => call.sql.includes('UPDATE entrepreneur_packages p SET media_id=first.media_id')));
});

test('rechaza un orden que no coincide con las imágenes actuales', async () => {
  const query = async (sql) => sql.startsWith('SELECT id FROM entrepreneur_packages') ? { rows: [{ id: pkg }] } : { rows: [{ id: a }, { id: b }] };
  const res = response();
  await withClient(query, () => controller.reorderEntrepreneurPackageImages({ params: { id: pkg }, body: { imageIds: [a] }, auth: { organizationId: 'org' } }, res, assert.fail));
  assert.equal(res.statusCode, 409);
});

test('borrar la última imagen deja el conjunto sin portada', async () => {
  const calls = [];
  const query = async (sql, args) => { calls.push({ sql, args }); if (sql.startsWith('DELETE FROM entrepreneur_package_images')) return { rows: [{ package_id: pkg }] }; return { rows: [] }; };
  const res = response();
  await withClient(query, () => controller.deleteEntrepreneurPackageImage({ params: { imageId: a }, auth: { organizationId: 'org' } }, res, assert.fail));
  assert.equal(res.statusCode, 204);
  assert.deepEqual(calls[0].args, [a, 'org']);
  assert.ok(calls.at(-1).sql.includes('media_id=NULL'));
});
