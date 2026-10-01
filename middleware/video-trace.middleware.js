const { randomUUID } = require('node:crypto');

exports.videoTrace = (req, res, next) => {
  if (req.method !== 'POST' || !/^\/conversations\/[^/]+\/messages\/video$/.test(req.path)) return next();
  const supplied = req.get('x-upload-id');
  const uploadId = /^[a-f0-9-]{36}$/i.test(supplied || '') ? supplied : randomUUID();
  const started = Date.now();
  req.videoLog = (stage, details = {}) => console.info(JSON.stringify({
    level: 'info', message: 'Video upload trace', uploadId, stage,
    elapsedMs: Date.now() - started, ...details,
  }));
  res.setHeader('X-Upload-Id', uploadId);
  req.videoLog('request_received', { declaredBytes: Number(req.get('content-length')) || null });
  req.once('aborted', () => req.videoLog('request_aborted'));
  res.once('finish', () => req.videoLog('response_sent', { status: res.statusCode }));
  res.once('close', () => { if (!res.writableFinished) req.videoLog('connection_closed', { status: res.statusCode }); });
  return next();
};
