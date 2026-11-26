const test = require('node:test');
const assert = require('node:assert/strict');
const conversations = require('../services/conversation.service');

test('invitación con botón guardada sin encabezado, imagen ni pie (null) es válida', () => {
  const data = conversations.parseCtaUrl({ header: null, headerImageUrl: null, body: '¡Únete al grupo!', footer: null, buttonText: 'Unirme', url: 'https://chat.whatsapp.com/abc' });
  assert.deepEqual(JSON.parse(JSON.stringify(data)), { body: '¡Únete al grupo!', buttonText: 'Unirme', url: 'https://chat.whatsapp.com/abc' });
  assert.equal(conversations.parseCtaUrl({ header: 'Grupo', body: 'Hola', buttonText: 'Unirme', url: 'https://x.com' }).header, 'Grupo');
  assert.throws(() => conversations.parseCtaUrl({ body: null, buttonText: 'Unirme', url: 'https://x.com' }));
});
