const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const auth = require('../services/auth.service');
const videos = require('../services/content-video.service');
const routes = require('../routes/content-video.routes');
const id = '11111111-1111-4111-8111-111111111111';

test('all planner endpoints require CRM session and only use its organization', async () => {
  const originals = { getSession: auth.getSession, ...Object.fromEntries(['list', 'create', 'update', 'setPublished', 'remove'].map(key => [key, videos[key]])) };
  const app = express(); app.use(cookieParser(), express.json()); app.use('/content-videos', routes);
  app.use((error, req, res, next) => { res.status(500).json({ error: 'unexpected' }); });
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}/content-videos`;
  const calls = [];
  auth.getSession = async token => token === 'demo-session' ? { organizationId: 'org-from-session', user: { role: 'owner' } } : null;
  for (const key of ['list', 'create', 'update', 'setPublished', 'remove']) videos[key] = async (...args) => { calls.push({ key, args }); return { ok: true }; };
  try {
    const cases = [ ['GET', '?channel=organic', 'list'], ['POST', '', 'create'], ['PUT', `/${id}`, 'update'], ['PATCH', `/${id}/published`, 'setPublished'], ['DELETE', `/${id}`, 'remove'] ];
    for (const [index, [method, path, key]] of cases.entries()) {
      const body = method === 'GET' ? undefined : JSON.stringify({ title: 'demo', organizationId: 'forged' });
      const denied = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body });
      assert.equal(denied.status, 401); assert.equal(calls.length, index);
      const allowed = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', cookie: `${auth.sessionCookie}=demo-session` }, body });
      assert.equal(allowed.status, key === 'create' ? 201 : 200);
      const call = calls.at(-1); assert.equal(call.key, key); assert.equal(call.args[0], 'org-from-session');
      if (['update', 'setPublished', 'remove'].includes(key)) assert.equal(call.args[1], id);
    }
    videos.update = async () => { throw Object.assign(Error('No encontrado'), { status: 404 }); };
    const notFound = await fetch(`${base}/${id}`, { method: 'PUT', headers: { cookie: `${auth.sessionCookie}=demo-session`, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(notFound.status, 404); assert.deepEqual(await notFound.json(), { error: 'No encontrado' });
  } finally {
    auth.getSession = originals.getSession;
    for (const key of ['list', 'create', 'update', 'setPublished', 'remove']) videos[key] = originals[key];
    await new Promise(resolve => server.close(resolve));
  }
});
