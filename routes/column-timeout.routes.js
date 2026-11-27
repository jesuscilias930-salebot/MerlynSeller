const router = require('express').Router();
const timeouts = require('../services/column-timeout.service');
const { requireUser, requireRole } = require('../middleware/auth.middleware');

const handle = (action) => async (req, res, next) => {
  try { const result = await action(req); return result === undefined ? res.status(204).end() : res.json(result); }
  catch (error) { return error.status ? res.status(error.status).json({ error: error.message }) : next(error); }
};

router.use(requireUser);
router.get('/', handle((req) => timeouts.list(req.auth.organizationId)));
router.put('/columns/:columnId', requireRole('owner', 'admin'), handle((req) => timeouts.save(req.auth.organizationId, req.params.columnId, req.body)));
router.delete('/columns/:columnId', requireRole('owner', 'admin'), handle(async (req) => { await timeouts.remove(req.auth.organizationId, req.params.columnId); }));
module.exports = router;
