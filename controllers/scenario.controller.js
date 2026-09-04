const scenarios = require('../services/scenario.service');
const handle = (error, res, next) => (error.status ? res.status(error.status).json({ error: error.message }) : next(error));

exports.list = async (req, res, next) => { try { return res.json(await scenarios.list(req.auth.organizationId)); } catch (error) { return handle(error, res, next); } };
exports.create = async (req, res, next) => { try { return res.status(201).json(await scenarios.create(req.auth.organizationId, req.body)); } catch (error) { return handle(error, res, next); } };
exports.update = async (req, res, next) => { try { return res.json(await scenarios.update(req.auth.organizationId, req.params.id, req.body)); } catch (error) { return handle(error, res, next); } };
exports.reorder = async (req, res, next) => { try { return res.json(await scenarios.reorder(req.auth.organizationId, req.body)); } catch (error) { return handle(error, res, next); } };
exports.remove = async (req, res, next) => { try { return res.json(await scenarios.remove(req.auth.organizationId, req.params.id)); } catch (error) { return handle(error, res, next); } };
exports.uploadEvidence = async (req, res, next) => {
  try {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Evidence image is required' });
    const contentType = (req.get('content-type') || '').split(';')[0].toLowerCase();
    const filename = decodeURIComponent(req.get('x-upload-filename') || 'evidence-image');
    return res.status(201).json(await scenarios.uploadEvidence({ buffer: req.body, contentType, filename }));
  } catch (error) { return handle(error, res, next); }
};
