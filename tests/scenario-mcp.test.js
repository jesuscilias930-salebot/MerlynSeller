const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const service = require('../services/scenario-mcp.service');
const draft = steps => ({ name: 'Prueba', triggerExamples: ['hola'], steps });
const end = { id: 'end', type: 'end', label: 'Fin' };
const resources = async (sql, args) => {
  assert.deepEqual(args, ['org-1']);
  assert.match(sql, /organization_id=\$1/);
  return { rows: sql.includes('lead_columns') ? [{ id: '11111111-1111-4111-8111-111111111111' }] : [] };
};
test('validation scopes resources, defaults inactive and rejects invalid graphs and foreign media', async () => {
  const client = { query: resources };
  assert.equal((await service.validate('org-1', draft([end]), client)).isActive, false);
  await assert.rejects(service.validate('org-1', draft([end, { ...end, id: 'orphan' }]), client), /no está conectado/);
  await assert.rejects(service.validate('org-1', draft([{ id: 'loop', label: 'Bucle', type: 'send_text', body: 'hola', nextStepId: 'loop' }]), client), /ciclo/);
  await assert.rejects(service.validate('org-1', draft([{ id: 'photo', label: 'Foto', type: 'send_media', items: [{ mediaId: 'foreign' }], nextStepId: 'end' }, end]), client), /archivo no pertenece/);
  await assert.rejects(service.validate('org-1', draft([{ id: 'move', label: 'Mover', type: 'move_column', columnId: '22222222-2222-4222-8222-222222222222', nextStepId: 'end' }, end]), client), /columna existente/);
  await assert.rejects(service.validate('org-1', draft([{ id: 'catalog', label: 'Catálogo', type: 'send_catalog', nextStepId: 'end' }, end]), client), /Configura el catálogo/);
});
test('codes are hashed, scoped and role checked; malformed token never queries DB', async () => {
  const originalQuery = db.query, originalTransaction = db.transaction; const calls = [];
  try {
    db.transaction = async fn => fn({ query: async (sql, args) => { calls.push({ sql, args }); return { rows: [] }; } });
    const session = await service.issue({ organizationId: 'org-1', user: { id: 'user-1' } });
    assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(calls[1].args[0], session.token); assert.match(calls[1].args[0], /^[a-f0-9]{64}$/);
    assert.deepEqual(calls[0].args, ['org-1', 'user-1']);
    let queries = 0;
    db.query = async (sql, args) => { queries++; assert.match(sql, /expires_at>now\(\)/); assert.match(sql, /m.role IN/); assert.equal(args[0], calls[1].args[0]); return { rows: [] }; };
    assert.equal(await service.authenticate('bad'), null); assert.equal(queries, 0);
    assert.equal(await service.authenticate(session.token), null); assert.equal(queries, 1);
  } finally { db.query = originalQuery; db.transaction = originalTransaction; }
});
test('save detects concurrent edits, accepts identical retry and inserts scoped inactive drafts', async () => {
  const original = db.transaction;
  const id = '11111111-1111-4111-8111-111111111111';
  const definition = { ...draft([end]), isActive: false, priority: 0, canInterrupt: true };
  let current = { id, key: 'existing', ...definition, aiDescription: null, position: 0, updatedAt: '2026-10-04' };
  let writes = 0;
  db.transaction = async fn => fn({ query: async (sql, args) => {
    if (sql.includes('advisory')) return { rows: [] };
    if (sql.includes('FOR UPDATE')) { assert.deepEqual(args, [id, 'org-1']); return { rows: current ? [current] : [] }; }
    if (/^(INSERT|UPDATE)/.test(sql)) { writes++; assert.equal(args[1], 'org-1'); assert.equal(args[3], false); return { rows: [{ ...definition, id }] }; }
    return resources(sql, args);
  } });
  try {
    await service.save('org-1', { id, expectedRevision: null, definition }); assert.equal(writes, 0);
    await assert.rejects(service.save('org-1', { id, expectedRevision: 'a'.repeat(64), definition: { ...definition, name: 'Cambio' } }), { status: 409 });
    assert.equal(writes, 0);
    current = null;
    await service.save('org-1', { id, expectedRevision: null, definition }); assert.equal(writes, 1);
  } finally { db.transaction = original; }
});
