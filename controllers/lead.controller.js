const leads = require('../services/lead.service');

const handle = (error, res, next) => (error.status
  ? res.status(error.status).json({ error: error.message })
  : next(error));

exports.board = async (req, res, next) => {
  try { return res.json(await leads.board(req.auth.organizationId, req.auth.user.id)); } catch (error) { return handle(error, res, next); }
};

exports.addColumn = async (req, res, next) => {
  try { return res.status(201).json(await leads.addColumn(req.auth.organizationId, req.body)); } catch (error) { return handle(error, res, next); }
};

exports.reorderColumns = async (req, res, next) => {
  try { return res.json(await leads.reorderColumns(req.auth.organizationId, req.body)); } catch (error) { return handle(error, res, next); }
};

exports.removeColumn = async (req, res, next) => {
  try { return res.json(await leads.removeColumn(req.auth.organizationId, req.params.id)); } catch (error) { return handle(error, res, next); }
};

exports.move = async (req, res, next) => {
  try { return res.json(await leads.move(req.auth.organizationId, req.params.id, req.body)); } catch (error) { return handle(error, res, next); }
};
