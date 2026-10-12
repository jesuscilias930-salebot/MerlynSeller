const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const db = require('../lib/db');
const videos = require('../services/content-video.service');
const id = '11111111-1111-4111-8111-111111111111';
const draft = { channel: 'organic', title: '  Primer pedido  ', script: 'Guion\nDos líneas', shots: 'Toma 1', prompts: 'Crear idea', recordingDate: '2026-10-15', publishingDate: '2026-10-16', isPublished: false, resultNotes: 'Resultados' };

test('create validates fields, calendar dates and booleans before touching storage', async () => {
  const original = db.query; let calls = 0;
  db.query = async (sql, args) => { calls++; assert.match(sql, /INSERT INTO content_videos/); assert.equal(args[0], 'org-a'); assert.equal(args[2], 'Primer pedido'); assert.equal(args[3], draft.script); return { rows: [{ id }] }; };
  try {
    for (const input of [{ ...draft, title: ' ' }, { ...draft, channel: 'unknown' }, { ...draft, isPublished: 'true' }, { ...draft, recordingDate: '2026-02-29' }, { ...draft, publishingDate: '2026-13-02' }, { ...draft, publishingDate: 'invalid' }, { ...draft, title: 'a'.repeat(161) }, { ...draft, prompts: 'a'.repeat(20001) }, { ...draft, organizationId: 'org-b' }]) {
      await assert.rejects(videos.create('org-a', input), { status: 400 });
    }
    assert.equal(calls, 0);
    assert.equal((await videos.create('org-a', draft)).id, id);
    assert.equal(calls, 1);
  } finally { db.query = original; }
});

test('optional text and dates have safe defaults and leap dates are accepted', async () => {
  const original = db.query;
  db.query = async (sql, args) => {
    assert.deepEqual(args, ['org-a', 'ads', 'Idea', '', '', '', '2028-02-29', null, false, '']);
    assert.match(sql, /to_char\(recording_date/);
    return { rows: [{ id, recordingDate: '2028-02-29' }] };
  };
  try { assert.equal((await videos.create('org-a', { channel: 'ads', title: 'Idea', recordingDate: '2028-02-29' })).recordingDate, '2028-02-29'); }
  finally { db.query = original; }
});

test('lists are scoped, paginated and escape wildcard searches with bound parameters', async () => {
  const original = db.query; const calls = [];
  db.query = async (sql, args) => {
    calls.push({ sql, args }); assert.match(sql, /organization_id=\$1 AND channel=\$2/); assert.equal(args[0], 'org-a');
    if (sql.includes('LIMIT $5')) { assert.match(sql, /ORDER BY is_published ASC/); return { rows: [{ id }] }; }
    if (sql.includes('FILTER')) return { rows: [{ total: 4, pending: 3, published: 1 }] };
    return { rows: [{ total: 2 }] };
  };
  try {
    const page = await videos.list('org-a', { channel: 'ads', q: "  50%_\\'  ", status: 'pending', page: '2', size: '12' });
    assert.equal(page.total, 2); assert.equal(page.page, 2); assert.deepEqual(page.stats, { total: 4, pending: 3, published: 1 });
    const list = calls.find(call => call.sql.includes('LIMIT $5'));
    assert.deepEqual(list.args, ['org-a', 'ads', "%50\\%\\_\\\\'%", false, 12, 24]);
    assert.doesNotMatch(list.sql, /50%/);
    for (const input of [{ channel: 'organic', size: '31' }, { channel: 'organic', page: '-1' }, { channel: 'organic', page: '1.5' }, { channel: 'organic', q: 'a'.repeat(121) }, { channel: 'organic', organizationId: 'org-b' }, { channel: 'ads', status: 'broken' }, {}]) {
      const before = calls.length; await assert.rejects(videos.list('org-a', input), { status: 400 }); assert.equal(calls.length, before);
    }
    calls.length = 0; await videos.list('org-a', { channel: 'organic' });
    assert.deepEqual(calls[0].args, ['org-a', 'organic', '%%', null, 12, 0]);
  } finally { db.query = original; }
});

test('updates, publication status and deletes always scope ID, organization and revision', async () => {
  const original = db.query; const calls = [];
  db.query = async (sql, args) => { calls.push({ sql, args }); assert.match(sql, /WHERE id=\$1 AND organization_id=\$2 AND revision=/); assert.deepEqual(args.slice(0, 2), [id, 'org-a']); return { rows: [{ id, revision: 2 }] }; };
  try {
    await videos.update('org-a', id, { ...draft, revision: 1 });
    assert.equal(calls[0].args[11], 1); assert.match(calls[0].sql, /revision=revision\+1/);
    await videos.setPublished('org-a', id, { isPublished: true, revision: 2 });
    assert.deepEqual(calls[1].args, [id, 'org-a', true, 2]); assert.doesNotMatch(calls[1].sql, /script=/);
    assert.deepEqual(await videos.remove('org-a', id, { revision: 3 }), { deleted: true });
    assert.deepEqual(calls[2].args, [id, 'org-a', 3]);
    const before = calls.length;
    await assert.rejects(videos.update('org-a', 'bad-id', { ...draft, revision: 1 }), { status: 400 });
    await assert.rejects(videos.setPublished('org-a', id, { isPublished: 'true', revision: 1 }), { status: 400 });
    await assert.rejects(videos.remove('org-a', id, {}), { status: 400 });
    assert.equal(calls.length, before);
  } finally { db.query = original; }
});

test('stale edits return conflict; foreign or deleted videos return not found without leakage', async () => {
  const original = db.query;
  try {
    for (const exists of [true, false]) {
      db.query = async (sql, args) => {
        assert.deepEqual(args.slice(0, 2), [id, 'org-a']);
        if (sql.startsWith('SELECT')) { assert.match(sql, /organization_id=\$2/); return { rows: exists ? [{ id }] : [] }; }
        return { rows: [] };
      };
      for (const run of [() => videos.update('org-a', id, { ...draft, revision: 1 }), () => videos.setPublished('org-a', id, { isPublished: false, revision: 1 }), () => videos.remove('org-a', id, { revision: 1 })]) {
        await assert.rejects(run(), { status: exists ? 409 : 404 });
      }
    }
  } finally { db.query = original; }
});

test('migration isolates records per organization and app protects the new browser write path', () => {
  const sql = readFileSync(new URL('../db/migrations/037_content_videos.sql', `file://${__filename}`), 'utf8');
  assert.match(sql, /organization_id uuid NOT NULL REFERENCES organizations/);
  assert.match(sql, /channel IN \('organic', 'ads'\)/);
  assert.match(sql, /recording_date date/); assert.match(sql, /is_published boolean NOT NULL DEFAULT false/);
  assert.match(sql, /ON content_videos \(organization_id, channel/);
  const app = readFileSync(new URL('../app.js', `file://${__filename}`), 'utf8');
  assert.match(app, /browserSessionPaths = \[[^\]]*'\/content-videos'/);
  assert.match(app, /app.use\('\/content-videos', require\('\.\/routes\/content-video.routes'\)\)/);
});
