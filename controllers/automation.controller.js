const automations = require('../services/automation.service');
const handle = (error, res, next) => (error.status ? res.status(error.status).json({ error: error.message }) : next(error));
exports.list = async (req, res, next) => { try { return res.json(await automations.list(req.auth.organizationId)); } catch (error) { return handle(error, res, next); } };
exports.create = async (req, res, next) => { try { return res.status(201).json(await automations.create(req.auth.organizationId, req.body)); } catch (error) { return handle(error, res, next); } };
exports.update = async (req, res, next) => { try { return res.json(await automations.update(req.auth.organizationId, req.params.id, req.body)); } catch (error) { return handle(error, res, next); } };
exports.remove = async (req, res, next) => { try { return res.json(await automations.remove(req.auth.organizationId, req.params.id)); } catch (error) { return handle(error, res, next); } };
