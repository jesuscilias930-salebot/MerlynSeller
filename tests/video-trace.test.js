const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { videoTrace } = require('../middleware/video-trace.middleware');
test('tracks arrival and disconnect without logging private data', t => {
  const logs = [];
  t.mock.method(console, 'info', text => logs.push(JSON.parse(text)));
  const req = new EventEmitter();
  Object.assign(req, { method:'POST', path:'/conversations/private-id/messages/video', get:key => ({'x-upload-id':'12345678-1234-1234-1234-123456789abc','content-length':'189582540'})[key] });
  const res = new EventEmitter();
  res.setHeader = () => {};
  res.statusCode = 200;
  videoTrace(req, res, () => {});
  res.emit('close');
  assert.deepEqual(logs.map(row => row.stage), ['request_received','connection_closed']);
  assert.equal(logs[0].declaredBytes, 189582540);
  assert.ok(!JSON.stringify(logs).includes('private-id'));
});
