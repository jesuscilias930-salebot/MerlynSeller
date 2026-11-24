const test = require('node:test');
const assert = require('node:assert/strict');
const { messageMetadataFor } = require('../services/inbound-message.service');
const { messagePreview } = require('../services/conversation.service');

test('guarda qué tipo de mensaje no compatible envió el cliente', () => {
  assert.deepEqual(messageMetadataFor({ type: 'unsupported', unsupported: { type: 'poll_creation' }, errors: [{ code: 131051, title: 'Message type unknown', error_data: { details: 'Message type is currently not supported.' } }] }),
    { unsupported: { type: 'poll_creation', code: 131051, title: 'Message type unknown', details: 'Message type is currently not supported.' } });
  assert.deepEqual(messageMetadataFor({ type: 'unknown', errors: [{ code: 131060, title: 'Message unavailable' }] }).unsupported, { type: undefined, code: 131060, title: 'Message unavailable', details: undefined });
  assert.equal(messageMetadataFor({ type: 'unsupported' }), null);
  assert.equal(messagePreview({ type: 'unsupported', body: null }), '⚠️ Mensaje que WhatsApp no comparte');
});
