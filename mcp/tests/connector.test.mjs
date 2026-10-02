import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../server.mjs';
import { apiOrigin, createClient } from '../client.mjs';

test('MCP publishes narrow tools, validates confirmation and separates draft from registration', async () => {
  const calls = [];
  const server = buildServer(async (path, body) => { calls.push({ path, body }); return { ok: true }; });
  const client = new Client({ name: 'test', version: '1' });
  const [a,b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const list = await client.listTools();
    assert.equal(list.tools.length, 5);
    const bad = await client.callTool({ name: 'confirmar_adquisicion', arguments: { draftId: 'bad', confirmed: false } });
    assert.equal(bad.isError, true); assert.equal(calls.length, 0);
    await client.callTool({ name: 'preparar_adquisicion', arguments: { supplierName: 'Proveedor', purchaseDate: '2026-10-01',
      purchaseItemsRequest: [{ productId: 3, isTaxed: true, isBulk: true, bulksReceived: 4, unitsPerBulk: 720, pricePerBulk: 3480 }] } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/mcp/acquisitions/drafts');
    assert.equal(calls[0].body.purchaseDate, '2026-10-01T00:00:00');
    assert.equal(calls[0].body.purchaseItemsRequest[0].individualUnitsReceived, 0);
  } finally { await client.close(); await server.close(); }
});

test('client rejects arbitrary paths and session for another backend', async () => {
  let sent = 0;
  const request = createClient({ origin: 'https://example.com', loadSession: async () => ({ origin: 'https://other.example', token: 'fake' }), fetchImpl: async () => { sent++; } });
  await assert.rejects(request('/auth/login'), /Ruta/);
  await assert.rejects(request('/mcp/acquisitions/1'), /Sesión/);
  assert.equal(sent, 0);
  assert.throws(() => apiOrigin('http://example.com'));
  assert.throws(() => apiOrigin('https://user:secret@example.com'));
});

test('ambiguous network failure never retries a stock write', async () => {
  let sent = 0;
  const request = createClient({ origin: 'https://example.com', loadSession: async () => ({ origin: 'https://example.com', token: 'fake' }),
    fetchImpl: async (_url, options) => { sent++; assert.equal(options.redirect, 'error'); throw new Error('network'); } });
  await assert.rejects(request('/mcp/acquisitions/drafts/11111111-1111-4111-8111-111111111111/confirm', { confirmed: true }), /mismo draftId/);
  assert.equal(sent, 1);
});
