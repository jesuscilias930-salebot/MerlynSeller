const test = require('node:test');
const assert = require('node:assert/strict');
const scenarios = require('../services/scenario.service');

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', NEW = '33333333-3333-4333-8333-333333333333';
const steps = [{ id: 'hola', type: 'send_text', label: 'Hola', body: 'Hola', nextStepId: 'fin' }, { id: 'fin', type: 'end', label: 'Fin' }];

test('clona pausado, con todo su contenido, y lo deja debajo del original', async () => {
  const original = { list: scenarios.list, create: scenarios.create, reorder: scenarios.reorder };
  let created, order;
  scenarios.list = async () => [
    { id: A, key: 'ver', name: 'Ver mercancía', isActive: true, triggerExamples: ['¿Puedo ver?'], aiDescription: null, priority: 3, canInterrupt: false, steps, quoteBundle: { id: '7', name: 'CE120' } },
    { id: B, key: 'envio', name: 'Envío', isActive: true, triggerExamples: ['envío'], steps },
  ];
  scenarios.create = async (_org, input) => { created = input; return { id: NEW, key: 'ver_mercancia_copia', ...input }; };
  scenarios.reorder = async (_org, input) => { order = input.scenarioIds; return input; };
  try {
    const copy = await scenarios.duplicate('org', A);
    assert.equal(created.name, 'Ver mercancía (copia)');
    assert.equal(created.isActive, false);
    assert.deepEqual(created.steps, steps);
    assert.deepEqual(created.triggerExamples, ['¿Puedo ver?']);
    assert.deepEqual(created.quoteBundle, { id: '7', name: 'CE120' });
    assert.equal(created.aiDescription, undefined);
    assert.equal(created.priority, 3); assert.equal(created.canInterrupt, false);
    assert.deepEqual(order, [A, NEW, B]);
    assert.equal(copy.position, 1);
    await assert.rejects(scenarios.duplicate('org', '44444444-4444-4444-8444-444444444444'), { status: 404 });
  } finally { Object.assign(scenarios, original); }
});

test('el nombre de la copia no se repite y respeta 100 caracteres', () => {
  const taken = new Set(['ver mercancía', 'ver mercancía (copia)']);
  assert.equal(scenarios.copyName('Ver mercancía', taken), 'Ver mercancía (copia 2)');
  assert.equal(scenarios.copyName('Ver mercancía (copia)', taken), 'Ver mercancía (copia 2)');
  assert.ok(scenarios.copyName('x'.repeat(100), new Set()).length <= 100);
});
