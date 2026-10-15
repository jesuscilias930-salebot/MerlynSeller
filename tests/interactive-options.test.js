const test = require('node:test');
const assert = require('node:assert/strict');
const options = require('../services/interactive-options');
const messageService = require('../services/message.service');

const packages = {
  body: '¿Qué paquete te interesa?',
  options: [
    { title: 'Caricatura 50 pares', description: '$446.50' },
    { title: 'Caricatura 100 pares', description: '$882' },
    { title: 'Caricatura 200 pares', description: '$1,728' },
    { title: 'Caricatura 500 pares', description: '$4,120' },
    { title: 'Deportivo Pro 450 pares', description: '$3,999' },
    { title: 'Ayúdame a elegir' },
  ],
};

test('más de tres opciones se envían como lista con descripción y ids estables', () => {
  const message = options.normalize(packages);
  assert.equal(message.format, 'list');
  assert.equal(message.buttonText, 'Ver opciones');
  assert.deepEqual(message.options.map((option) => option.id), [
    'caricatura_50_pares', 'caricatura_100_pares', 'caricatura_200_pares', 'caricatura_500_pares', 'deportivo_pro_450_pares', 'ayudame_a_elegir',
  ]);
  const interactive = options.toInteractive({ ...packages, header: 'Paquetes', footer: 'Envío aparte', sectionTitle: 'Paquetes' });
  assert.equal(interactive.type, 'list');
  assert.deepEqual(interactive.header, { type: 'text', text: 'Paquetes' });
  assert.equal(interactive.action.sections[0].title, 'Paquetes');
  assert.deepEqual(interactive.action.sections[0].rows[0], { id: 'caricatura_50_pares', title: 'Caricatura 50 pares', description: '$446.50' });
  assert.deepEqual(interactive.action.sections[0].rows[5], { id: 'ayudame_a_elegir', title: 'Ayúdame a elegir' });
});

test('hasta tres opciones cortas sin descripción se envían como botones', () => {
  const interactive = options.toInteractive({ body: '¿Te interesa?', options: [{ title: 'Sí' }, { title: 'No' }, { title: 'Más información' }] });
  assert.equal(interactive.type, 'button');
  assert.deepEqual(interactive.action.buttons[2], { type: 'reply', reply: { id: 'mas_informacion', title: 'Más información' } });
  assert.equal(options.normalize({ body: 'x', format: 'list', options: [{ title: 'Sí' }] }).format, 'list');
});

test('rechaza mensajes fuera de los límites de WhatsApp', () => {
  assert.throws(() => options.normalize({ ...packages, format: 'buttons' }), { status: 400, message: /máximo 3/ });
  assert.throws(() => options.normalize({ body: 'x', format: 'buttons', options: [{ title: 'Uno', description: 'detalle' }] }), /no admiten descripción/);
  assert.throws(() => options.normalize({ body: 'x', options: [{ title: 'a'.repeat(25) }] }), /máximo 24/);
  assert.throws(() => options.normalize({ body: 'x', options: Array.from({ length: 11 }, (_, i) => ({ title: `Opción ${i}` })) }), /máximo 10/);
  assert.throws(() => options.normalize({ body: 'x', options: [{ title: 'Sí' }, { title: 'sí' }] }), /repetida/);
  assert.throws(() => options.normalize({ body: ' ', options: [{ title: 'Sí' }] }), /obligatorio/);
  assert.throws(() => options.normalize({ body: 'x', options: [] }), /al menos una/);
  assert.throws(() => options.normalize({ body: 'x', options: [{ title: 'Sí', id: 'con espacio' }] }), /identificador/);
});

test('envía a Meta el payload interactivo de lista', async () => {
  const original = global.fetch;
  const env = { ...process.env };
  let sent;
  Object.assign(process.env, { WHATSAPP_ACCESS_TOKEN: 'token', WHATSAPP_PHONE_NUMBER_ID: '123', WHATSAPP_GRAPH_API_VERSION: 'v21.0' });
  global.fetch = async (_url, request) => { sent = JSON.parse(request.body); return { ok: true, json: async () => ({ messages: [{ id: 'wamid.1' }] }) }; };
  try {
    const result = await messageService.sendInteractiveOptions({ to: '+5212721234567', kind: 'options', ...options.normalize(packages) });
    assert.equal(result.messages[0].id, 'wamid.1');
    assert.equal(sent.type, 'interactive');
    assert.equal(sent.to, '5212721234567');
    assert.equal(sent.interactive.type, 'list');
    assert.equal(sent.interactive.action.sections[0].rows.length, 6);
    await assert.rejects(messageService.sendInteractiveOptions({ to: '5212721234567', body: 'x', options: [] }), { status: 400 });
  } finally { global.fetch = original; process.env = env; }
});
