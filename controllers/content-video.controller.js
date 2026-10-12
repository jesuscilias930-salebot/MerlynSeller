const videos = require('../services/content-video.service');
const handle = (error, res, next) => error.status ? res.status(error.status).json({ error: error.message }) : next(error);

exports.list = async (req, res, next) => { try { return res.json(await videos.list(req.auth.organizationId, req.query)); } catch (error) { return handle(error, res, next); } };
exports.create = async (req, res, next) => { try { return res.status(201).json(await videos.create(req.auth.organizationId, req.body)); } catch (error) { return handle(error, res, next); } };
exports.update = async (req, res, next) => { try { return res.json(await videos.update(req.auth.organizationId, req.params.id, req.body)); } catch (error) { return handle(error, res, next); } };
exports.setPublished = async (req, res, next) => { try { return res.json(await videos.setPublished(req.auth.organizationId, req.params.id, req.body)); } catch (error) { return handle(error, res, next); } };
exports.remove = async (req, res, next) => { try { return res.json(await videos.remove(req.auth.organizationId, req.params.id, req.body)); } catch (error) { return handle(error, res, next); } };
