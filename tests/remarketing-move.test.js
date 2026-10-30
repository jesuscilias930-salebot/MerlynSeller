const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const realtime = require('../lib/realtime');
const moves = require('../services/remarketing-move.service');

const tpl = '11111111-1111-4111-8111-111111111111';
const col = '22222222-2222-4222-8222-222222222222';
const withDb = async (handler, fn) => {
  const original = { query: db.query, publish: realtime.publish };
  const calls = [];
  db.query = async (sql, args) => { calls.push({ sql, args }); return handler(sql, args) || { rows: [] }; };
  realtime.publish = async () => {};
  try { await fn(calls); } finally { db.query = original.query; realtime.publish = original.publish; }
};

test('guarda la configuración por plantilla y la borra si no hay columnas', async () => {
  await withDb((sql) => {
    if (sql.includes('FROM whatsapp_templates')) return { rows: [{ 1: 1 }] };
    if (sql.includes('FROM lead_columns')) return { rows: [{ n: 1 }] };
    return null;
  }, async (calls) => {
    await moves.save('org', { templateId: tpl, afterSendColumnId: col, onReplyColumnId: col });
    assert.ok(calls.some((call) => call.sql.includes('INSERT INTO remarketing_move_rules') && call.args.join() === ['org', tpl, col, col, ''].join()));
    await moves.save('org', { templateId: tpl });
    assert.ok(calls.at(-1).sql.startsWith('DELETE FROM remarketing_move_rules'));
    await moves.save('org', { templateId: tpl, homeColumnId: col });
    const insert = calls.at(-1);
    assert.ok(insert.sql.includes('home_column_id') && insert.args[4] === col, 'solo la columna del tablero también se guarda');
    await assert.rejects(moves.save('org', { afterSendColumnId: col }), { status: 400 });
  });
});

test('al responder mueve y fija solo la primera vez; sin configuración avisa para usar R-HOT', async () => {
  let inserted = true;
  await withDb((sql) => {
    if (sql.includes('JOIN remarketing_campaigns')) return { rows: [{ id: 'camp', on_reply_column_id: col }] };
    if (sql.startsWith('INSERT INTO remarketing_reply_moves')) return { rows: inserted ? [{ campaign_id: 'camp' }] : [] };
    if (sql.startsWith('UPDATE conversations')) return { rows: [{ id: 'conv' }] };
    return null;
  }, async (calls) => {
    assert.deepEqual(await moves.onReply('org', 'conv', null), { configured: true, moved: true });
    const update = calls.find((call) => call.sql.startsWith('UPDATE conversations'));
    assert.match(update.sql, /column_pinned_at = now\(\)/);
    assert.doesNotMatch(update.sql, /column_pinned_at IS NULL/, 'se mueve aunque esté fijado');
    inserted = false;
    assert.deepEqual(await moves.onReply('org', 'conv', 'wamid.1'), { configured: true, moved: false });
  });
  await withDb(() => null, async () => {
    assert.deepEqual(await moves.onReply('org', 'conv', null), { configured: false, moved: false });
  });
});

test('al enviarse respeta a los leads fijados', async () => {
  await withDb((sql) => {
    if (sql.includes('JOIN remarketing_campaigns')) return { rows: [{ organization_id: 'org', conversation_id: 'conv', after_send_column_id: col }] };
    return null;
  }, async (calls) => {
    assert.equal(await moves.afterSent('msg'), false);
    assert.match(calls.at(-1).sql, /column_pinned_at IS NULL/);
  });
});
