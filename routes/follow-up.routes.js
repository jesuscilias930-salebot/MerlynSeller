const router = require('express').Router();
const followUps = require('../services/follow-up.service');
const { requireUser, requireRole } = require('../middleware/auth.middleware');

const handle = (action) => async (req, res, next) => {
  try { const result = await action(req); return result === undefined ? res.status(204).end() : res.json(result); }
  catch (error) { return error.status ? res.status(error.status).json({ error: error.message }) : next(error); }
};

router.use(requireUser);
router.get('/', handle((req) => followUps.list(req.auth.organizationId)));
router.put('/columns/:columnId', requireRole('owner', 'admin'), handle((req) => followUps.save(req.auth.organizationId, req.params.columnId, req.body)));
router.delete('/columns/:columnId', requireRole('owner', 'admin'), handle(async (req) => { await followUps.remove(req.auth.organizationId, req.params.columnId); }));
router.get('/conversations/:id', handle((req) => followUps.status(req.auth.organizationId, req.params.id)));
router.post('/conversations/:id/stop', handle((req) => followUps.stop(req.auth.organizationId, req.params.id)));
module.exports = router;
