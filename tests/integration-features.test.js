const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const features = require('../services/integration-features.service');
test('modes default to sandbox; credentials never appear in settings', async () => {
  const original = db.query; db.query = async () => ({ rows: [] });
  try { assert.deepEqual(await features.get('org'), { envia: 'sandbox', stripe: 'sandbox' }); }
  finally { db.query = original; }
});
test('production Envia never falls back to legacy/test credentials', () => {
  const old = { ...process.env };
  try {
    process.env.ENVIA_TOKEN = 'fixture-legacy'; process.env.ENVIA_TOKEN_SANDBOX = 'fixture-test'; delete process.env.ENVIA_TOKEN_PRODUCTION;
    assert.equal(features.enviaToken('sandbox'), 'fixture-test'); assert.equal(features.enviaToken('production'), '');
    process.env.ENVIA_TOKEN_PRODUCTION = 'fixture-live'; assert.equal(features.enviaToken('production'), 'fixture-live');
  } finally { process.env = old; }
});
test('rejects arbitrary columns, missing credentials and unconfirmed production', async () => {
  await assert.rejects(features.save('org', { service: 'malicious', environment: 'sandbox' }), { status: 400 });
  await assert.rejects(features.save('org', { service: 'envia', environment: 'production' }), { status: 400 });
  const old = process.env.ENVIA_TOKEN_PRODUCTION; delete process.env.ENVIA_TOKEN_PRODUCTION;
  try { await assert.rejects(features.save('org', { service: 'envia', environment: 'production', confirmProduction: true }), { status: 400 }); }
  finally { if (old !== undefined) process.env.ENVIA_TOKEN_PRODUCTION = old; }
});
test('updating one mode does not overwrite the other', async () => {
  const original = db.query, old = process.env.ENVIA_TOKEN_SANDBOX;
  process.env.ENVIA_TOKEN_SANDBOX = 'fixture';
  db.query = async (sql, args) => {
    assert.equal(args[0], 'org');
    if (sql.startsWith('INSERT')) { assert.match(sql, /envia_environment/); assert.doesNotMatch(sql, /stripe_environment/); }
    return { rows: [{ envia: 'sandbox', stripe: 'production' }] };
  };
  try { assert.equal((await features.save('org', { service: 'envia', environment: 'sandbox' })).stripe, 'production'); }
  finally { db.query = original; if (old === undefined) delete process.env.ENVIA_TOKEN_SANDBOX; else process.env.ENVIA_TOKEN_SANDBOX = old; }
});
