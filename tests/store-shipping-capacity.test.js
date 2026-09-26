const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const releases = [];
const path = require.resolve('../services/envia-shipping.service');
require.cache[path] = { id:path,filename:path,loaded:true,exports:{
  quoteStore:()=>new Promise(resolve=>releases.push(()=>resolve({environment:'sandbox',rates:[]})))
}};
const router=require('../routes/store-shipping.routes');
test('bounds concurrent quotes and releases capacity after completion',async()=>{
  process.env.STORE_SHIPPING_SECRET='test-secret-with-at-least-thirty-two-characters';
  process.env.STORE_ORGANIZATION_ID='test';
  const app=express();app.use(express.json());app.use(router);
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const send=()=>fetch(`http://127.0.0.1:${server.address().port}/quote`,{method:'POST',headers:{'Content-Type':'application/json','X-Store-Shipping-Secret':process.env.STORE_SHIPPING_SECRET},body:'{}'});
  const waitFor=async count=>{for(let i=0;i<100 && releases.length<count;i++)await new Promise(r=>setTimeout(r,10));assert.equal(releases.length,count);};
  try {
    const active=Array.from({length:8},send);await waitFor(8);
    const busy=await send();assert.equal(busy.status,429);assert.equal(busy.headers.get('retry-after'),'3');
    releases.splice(0).forEach(r=>r());for(const response of await Promise.all(active))assert.equal(response.status,200);
    const next=send();await waitFor(1);releases.shift()();assert.equal((await next).status,200);
  } finally {releases.splice(0).forEach(r=>r());server.closeAllConnections();await new Promise(r=>server.close(r));}
});
