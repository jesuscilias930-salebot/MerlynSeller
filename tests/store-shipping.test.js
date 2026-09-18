const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
let calls = 0;
const servicePath = require.resolve('../services/envia-shipping.service');
require.cache[servicePath] = { id: servicePath, filename: servicePath, loaded: true, exports: { quoteStore: async (org, input) => {
  calls++; assert.equal(org, 'test-org'); assert.equal(input.carrier, undefined); assert.equal(input.settings.currency, 'MXN');
  return { environment: 'sandbox', rates: [{carrier:'test',service:'ground',currency:'MXN',totalPrice:'125.50'}, {carrier:'bad',service:'ground',currency:'USD',totalPrice:10}] };
} } };
const router = require('../routes/store-shipping.routes');
test('internal quote rejects unauthenticated/browser calls and strips foreign currency', async () => {
  process.env.STORE_SHIPPING_SECRET = 'test-only-secret-which-is-longer-than-32-characters';
  process.env.STORE_ORGANIZATION_ID = 'test-org';
  const app=express();app.use(express.json());app.use('/internal/store-shipping',router);
  const server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
  try {
    const url=`http://127.0.0.1:${server.address().port}/internal/store-shipping/quote`;
    const send=(headers={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({destination:{},packages:[],organizationId:'other',carrier:'injected'})});
    assert.equal((await send()).status,401);assert.equal(calls,0);
    assert.equal((await send({'X-Store-Shipping-Secret':process.env.STORE_SHIPPING_SECRET,Origin:'https://bad.example'})).status,401);assert.equal(calls,0);
    const result=await send({'X-Store-Shipping-Secret':process.env.STORE_SHIPPING_SECRET});assert.equal(result.status,200);
    const data=await result.json();assert.equal(data.rates.length,1);assert.equal(data.rates[0].totalPrice,125.5);assert.equal(data.environment,'sandbox');
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
