const shipping = require('../services/envia-shipping.service');
const handle = (error, res, next) => error.status ? res.status(error.status).json({ error: error.message }) : next(error);
exports.settings = async (req, res, next) => { try { return res.json(await shipping.getSettings(req.auth.organizationId)); } catch (error) { return handle(error, res, next); } };
exports.saveSettings = async (req, res, next) => { try { return res.json(await shipping.saveSettings(req.auth.organizationId, req.body)); } catch (error) { return handle(error, res, next); } };
exports.quote = async (req, res, next) => { try { return res.json(await shipping.quote(req.auth.organizationId, req.body)); } catch (error) { return handle(error, res, next); } };
exports.generate = async (req, res, next) => { try { return res.status(201).json(await shipping.generate(req.auth.organizationId, req.body)); } catch (error) { return handle(error, res, next); } };
exports.list = async (req, res, next) => { try { return res.json(await shipping.list(req.auth.organizationId, req.query.conversationId)); } catch (error) { return handle(error, res, next); } };
