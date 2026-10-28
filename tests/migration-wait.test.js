const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const waitForMigrations = require('../lib/migration-wait');

test('el worker espera a que se apliquen las migraciones y luego arranca', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-'));
  fs.writeFileSync(path.join(directory, '001.sql'), ''); fs.writeFileSync(path.join(directory, '002.sql'), '');
  let calls = 0;
  const db = { query: async () => { calls += 1; if (calls === 1) throw new Error('no table'); return { rows: calls < 3 ? [{ filename: '001.sql' }] : [{ filename: '001.sql' }, { filename: '002.sql' }] }; } };
  assert.equal(await waitForMigrations(db, { directory, intervalMs: 1, timeoutMs: 1000 }), true);
  assert.equal(calls, 3);
  const never = { query: async () => ({ rows: [] }) };
  assert.equal(await waitForMigrations(never, { directory, intervalMs: 1, timeoutMs: 5 }), false);
});
