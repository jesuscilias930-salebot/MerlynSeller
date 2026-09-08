const templates = require('../services/whatsapp-template.service');
const handle = (error, res, next) => error.status ? res.status(error.status).json({ error: error.message }) : next(error);
exports.list = async (req, res, next) => { try { return res.json(await templates.list(req.auth.organizationId)); } catch (error) { return handle(error, res, next); } };
exports.sync = async (req, res, next) => { try { return res.json(await templates.sync(req.auth.organizationId)); } catch (error) { return handle(error, res, next); } };
exports.updateMappings = async (req, res, next) => { try { return res.json(await templates.updateMappings(req.auth.organizationId, req.params.id, req.body.mappings)); } catch (error) { return handle(error, res, next); } };
