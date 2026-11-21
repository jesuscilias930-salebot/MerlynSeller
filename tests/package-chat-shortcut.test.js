const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const controller = require('../controllers/settings.controller');

const response = () => { const res = { statusCode: 200 }; res.status = (code) => { res.statusCode = code; return res; }; res.json = (body) => { res.body = body; return res; }; return res; };

test('activa el conjunto como atajo del chat sin tocar los demás campos', async () => {
  const original = db.query; let call;
  db.query = async (sql, args) => { call = { sql, args }; return { rows: [{ id: 'p1', name: 'Caricatura', chat_shortcut: args[7] }] }; };
  try {
    const res = response();
    await controller.updateEntrepreneurPackage({ params: { id: 'p1' }, auth: { organizationId: 'org' }, body: { chatShortcut: true } }, res, (error) => { throw error; });
    assert.equal(res.body.chatShortcut, true);
    assert.match(call.sql, /chat_shortcut=COALESCE\(\$8,chat_shortcut\)/);
    assert.deepEqual(call.args.slice(2), [undefined, undefined, undefined, undefined, undefined, true]);
    const other = response();
    await controller.updateEntrepreneurPackage({ params: { id: 'p1' }, auth: { organizationId: 'org' }, body: { name: 'Nuevo' } }, other, (error) => { throw error; });
    assert.equal(call.args[7], null, 'sin chatShortcut se conserva el valor actual');
    const invalid = response();
    await controller.updateEntrepreneurPackage({ params: { id: 'p1' }, auth: { organizationId: 'org' }, body: { chatShortcut: 'si' } }, invalid, (error) => { throw error; });
    assert.equal(invalid.statusCode, 400);
  } finally { db.query = original; }
});
