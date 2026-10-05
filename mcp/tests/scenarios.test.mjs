import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildScenarioServer } from '../scenario-server.mjs';
import { createScenarioClient } from '../scenario-client.mjs';

test('scenario tools default off, validate without saving and reject invalid IDs', async () => {
  const calls = [];
  const server = buildScenarioServer(async (path, body) => { calls.push({ path, body }); return { ok: true }; });
  const client = new Client({ name: 'test', version: '1' });
  const [a,b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const definition = { name: 'Saludo', triggerExamples: ['hola'], steps: [{ id: 'end', type: 'end', label: 'Fin' }] };
  try {
    const list = await client.listTools();
    assert.equal(list.tools.length, 4);
    assert.equal(list.tools.find(tool => tool.name === 'guardar_escenario').annotations.readOnlyHint, false);
    await client.callTool({ name: 'validar_escenario', arguments: { definition } });
    assert.equal(calls[0].path, '/mcp/scenarios/validate');
    assert.equal(calls[0].body.isActive, false);
    const bad = await client.callTool({ name: 'guardar_escenario', arguments: { id: 'bad', expectedRevision: null, definition } });
    assert.equal(bad.isError, true); assert.equal(calls.length, 1);
    await client.callTool({ name: 'guardar_escenario', arguments: { id: '11111111-1111-4111-8111-111111111111', expectedRevision: null, definition } });
    assert.equal(calls[1].path, '/mcp/scenarios/definition');
    assert.equal(calls[1].body.definition.isActive, false);
  } finally { await client.close(); await server.close(); }
});

test('scenario client restricts backend, routes, PUT method and never retries', async () => {
  let count = 0;
  const origin = 'https://example.com'; const token = 'a'.repeat(43);
  const request = createScenarioClient({ origin, loadSession: async () => ({ origin, token }), fetchImpl: async (_url, options) => {
    count++; assert.equal(options.method, 'PUT'); assert.equal(options.redirect, 'error'); throw new Error('network');
  } });
  await assert.rejects(request('/settings'), /Ruta/);
  await assert.rejects(request('/mcp/scenarios/definition', {}), /mismo ID/);
  assert.equal(count, 1);
  const wrong = createScenarioClient({ origin, loadSession: async () => ({ origin: 'https://other.com', token }), fetchImpl: async () => { count++; } });
  await assert.rejects(wrong('/mcp/scenarios'), /Sesión/); assert.equal(count, 1);
});
