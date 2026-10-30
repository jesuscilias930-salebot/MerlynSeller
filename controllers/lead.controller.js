const leads = require('../services/lead.service');
const boards = require('../services/lead-board.service');

const handle = (error, res, next) => (error.status
  ? res.status(error.status).json({ error: error.message })
  : next(error));

exports.board = async (req, res, next) => {
  try { return res.json(await leads.board(req.auth.organizationId, req.auth.user.id, req.query.boardId)); } catch (error) { return handle(error, res, next); }
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

exports.moveAllFromColumn = async (req, res, next) => {
  try { return res.json(await leads.moveAllFromColumn(req.auth.organizationId, req.params.id, req.body)); } catch (error) { return handle(error, res, next); }
};

exports.listBoards = async (req, res, next) => {
  try { return res.json(await boards.list(req.auth.organizationId, req.auth.user.id)); } catch (error) { return handle(error, res, next); }
};
exports.createBoard = async (req, res, next) => {
  try { return res.status(201).json(await boards.create(req.auth.organizationId, req.body)); } catch (error) { return handle(error, res, next); }
};
exports.updateBoard = async (req, res, next) => {
  try { return res.json(await boards.update(req.auth.organizationId, req.params.id, req.body)); } catch (error) { return handle(error, res, next); }
};
exports.removeBoard = async (req, res, next) => {
  try { return res.json(await boards.remove(req.auth.organizationId, req.params.id)); } catch (error) { return handle(error, res, next); }
};
exports.reorderBoards = async (req, res, next) => {
  try { return res.json(await boards.reorder(req.auth.organizationId, req.body)); } catch (error) { return handle(error, res, next); }
};
