const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { stat } = require('node:fs/promises');
const { videoUpload, MAX_VIDEO_UPLOAD_BYTES } = require('../middleware/video-upload.middleware');
const response = () => ({ status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
function request(chunks, headers = {}) {
  const req = Readable.from(chunks);
  req.get = key => ({ 'content-type': 'video/quicktime', ...headers })[key];
  return req;
}
test('streams files above 16 MB without creating a request buffer and cleans up', async () => {
  let path;
  const upload = videoUpload(async (req, res) => {
    path = req.videoUploadPath;
    assert.equal(req.body, undefined);
    assert.equal((await stat(path)).size, 17 * 1024 * 1024);
    res.status(202).json({ ok: true });
  });
  const res = response();
  await upload(request(Array(17).fill(Buffer.alloc(1024 * 1024))), res, error => { throw error; });
  assert.equal(res.code, 202);
  await assert.rejects(stat(path), { code: 'ENOENT' });
});
test('rejects oversized, empty and unsupported uploads', async () => {
  const upload = videoUpload(() => assert.fail('must not send invalid media'));
  for (const [headers, code] of [[{'content-length': String(MAX_VIDEO_UPLOAD_BYTES + 1)},413], [{'content-type':'text/plain'},415], [{},400]]) {
    const res = response();
    await upload(request([], headers), res, error => { throw error; });
    assert.equal(res.code, code);
  }
});
test('releases upload slot and removes originals when handler fails', async () => {
  let path;
  let caught;
  await videoUpload(async req => { path = req.videoUploadPath; throw new Error('failed'); })(request([Buffer.from('test')]), response(), error => { caught = error; });
  assert.equal(caught.message, 'failed');
  await assert.rejects(stat(path), {code:'ENOENT'});
  const res = response();
  await videoUpload(async (req, result) => result.status(202).json({}))(request([Buffer.from('test')]), res, error => { throw error; });
  assert.equal(res.code, 202);
});
