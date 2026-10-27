const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const conversations = require('../services/conversation.service');

test('la vista previa muestra el último mensaje aunque sea foto, documento o plantilla', () => {
  const preview = conversations.messagePreview;
  assert.equal(preview({ type: 'text', body: ' Hola ' }), 'Hola');
  assert.equal(preview({ type: 'image', body: null }), '📷 Foto');
  assert.equal(preview({ type: 'image', body: 'Paquete 1' }), '📷 Paquete 1');
  assert.equal(preview({ type: 'document', body: '', filename: 'catalogo.pdf' }), '📄 catalogo.pdf');
  assert.equal(preview({ type: 'interactive', body: JSON.stringify({ body: '¿Qué talla buscas?' }) }), '¿Qué talla buscas?');
  assert.equal(preview({ type: 'template', body: JSON.stringify({ templateName: 'recordatorio_pedido' }) }), '📋 Plantilla: recordatorio_pedido');
  assert.equal(preview({ type: 'audio' }), '🎤 Audio');
  assert.equal(preview({ type: 'text', body: 'x', deleted: true }), '🚫 Se eliminó este mensaje');
  assert.equal(preview({ type: null }), null);
});

test('la lista ordena por el último mensaje y arma la vista previa', async () => {
  const original = db.query;
  let sql;
  db.query = async (text) => { sql = text; return { rows: [{ id: 'c1', latest_body: null, latest_type: 'image', latest_filename: null, latest_deleted: false, lastDirection: 'outbound' }] }; };
  try {
    const rows = await conversations.list('org', 'user');
    assert.deepEqual(rows, [{ id: 'c1', lastDirection: 'outbound', last_message: '📷 Foto' }]);
    assert.match(sql, /ORDER BY created_at DESC, COALESCE\(outbound_sequence, 0\) DESC LIMIT 1/);
    assert.match(sql, /ORDER BY COALESCE\(latest.created_at, c.updated_at\) DESC/);
  } finally { db.query = original; }
});
