const analysis = require('../services/conversation-analysis.service');
const handle = (error, res, next) => {
  if (error.status) return res.status(error.status).json({ error: error.message });
  if (error.code === '57014') return res.status(503).json({ error: 'La consulta tardó demasiado. Reduce el periodo o las columnas e intenta de nuevo.' });
  return next(error);
};
exports.columns = async (req, res, next) => { try { return res.json(await analysis.columns(req.auth.organizationId)); } catch (error) { return handle(error, res, next); } };
exports.preview = async (req, res, next) => { try { return res.json(await analysis.preview(req.auth.organizationId, req.auth.user.id, req.body)); } catch (error) { return handle(error, res, next); } };
exports.prepare = async (req, res, next) => { try { return res.json(await analysis.prepare(req.auth.organizationId, req.auth.user.id, req.body)); } catch (error) { return handle(error, res, next); } };
