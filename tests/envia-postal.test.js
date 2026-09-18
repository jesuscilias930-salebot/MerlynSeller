const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalize, lookup } = require('../services/envia-postal.service');

test('normaliza códigos de estado y nombres de colonia sin inventar IDs', () => {
  const row = { zip_code: '72824', country: { code: 'MX' }, state: { name: 'Puebla', code: { '2digit': 'PU' } }, locality: 'San Andrés Cholula', suburbs: ['Emiliano Zapata', 'Emiliano Zapata'] };
  const result = normalize([row, { ...row, zip_code: '99999' }], '72824');
  assert.deepEqual(result.localities, [{ stateCode: 'PU', stateName: 'Puebla', city: 'San Andrés Cholula', districts: ['Emiliano Zapata'] }]);
});
test('rechaza códigos postales inválidos antes de consultar', async () => {
  await assert.rejects(lookup('../settings'), { status: 400 });
});
test('respuestas vacías no generan localidades ficticias', () => {
  assert.deepEqual(normalize(null, '72824').localities, []);
});
test('errores externos se devuelven sin filtrar detalles internos', async () => {
  const original = global.fetch;
  global.fetch = async () => { throw new Error('Internal secret'); };
  try { await assert.rejects(lookup('12345'), { status: 502, message: 'No pudimos consultar las colonias en Envia. Intenta nuevamente.' }); }
  finally { global.fetch = original; }
});
