const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const auth = require('../services/auth.service');
const analysis = require('../services/conversation-analysis.service');
const routes = require('../routes/conversation-analysis.routes');

test('export endpoints require owner/admin session, scope organization and user, and surface safe errors', async () => {
  const keys = ['columns', 'preview', 'prepare'];
  const originals = { getSession: auth.getSession, ...Object.fromEntries(keys.map(key => [key, analysis[key]])) };
  const app = express(); app.use(cookieParser(), express.json()); app.use('/conversation-analysis', routes);
  app.use((error, req, res, next) => res.status(500).json({ error: 'Unexpected error' }));
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}/conversation-analysis`;
  let role = 'owner'; const calls = [];
  auth.getSession = async token => token === 'test-session' ? { organizationId: 'session-org', user: { id: 'session-user', role } } : null;
  keys.forEach(key => { analysis[key] = async (...args) => { calls.push({ key, args }); return { ok: true }; }; });
  const cases = [['GET', 'columns'], ['POST', 'preview'], ['POST', 'prepare']];
  const run = (method, endpoint, cookie) => fetch(`${base}/${endpoint}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie: `${auth.sessionCookie}=test-session` } : {}) }, body: method === 'POST' ? JSON.stringify({ organizationId: 'forged', userId: 'forged' }) : undefined });
  try {
    for (const [method, endpoint] of cases) { assert.equal((await run(method, endpoint, false)).status, 401); }
    assert.equal(calls.length, 0);
    for (const denied of ['agent', 'supervisor']) { role = denied; for (const [method, endpoint] of cases) assert.equal((await run(method, endpoint, true)).status, 403); }
    assert.equal(calls.length, 0);
    for (const allowed of ['owner', 'admin']) {
      role = allowed;
      for (const [method, endpoint] of cases) {
        assert.equal((await run(method, endpoint, true)).status, 200);
        const call = calls.at(-1); assert.equal(call.key, endpoint); assert.equal(call.args[0], 'session-org');
        if (endpoint !== 'columns') assert.equal(call.args[1], 'session-user');
      }
    }
    analysis.prepare = async () => { throw Object.assign(Error('La selección cambió'), { status: 409 }); };
    const stale = await run('POST', 'prepare', true); assert.equal(stale.status, 409); assert.deepEqual(await stale.json(), { error: 'La selección cambió' });
    analysis.preview = async () => { throw Object.assign(Error('private query information'), { code: '57014' }); };
    const timeout = await run('POST', 'preview', true); assert.equal(timeout.status, 503); assert.doesNotMatch(JSON.stringify(await timeout.json()), /private query/);
  } finally {
    auth.getSession = originals.getSession; keys.forEach(key => { analysis[key] = originals[key]; });
    await new Promise(resolve => server.close(resolve));
  }
});
