const router = require('express').Router();
const { requireUser, requireRole } = require('../middleware/auth.middleware');
const rules = require('../services/column-rule.service');

router.use(requireUser);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const handle = (fn, status = 200) => async (req, res, next) => {
  try { res.status(status).json(await fn(req)); }
  catch (error) { if ([400, 404].includes(error.status)) return res.status(error.status).json({ error: error.message }); return next(error); }
};
const org = (req) => req.auth.organizationId;
router.get('/', handle((req) => rules.list(org(req))));
router.post('/', requireRole('owner', 'admin'), handle((req) => rules.create(org(req), req.body), 201));
router.put('/order', requireRole('owner', 'admin'), handle((req) => rules.reorder(org(req), req.body)));
router.put('/:id', requireRole('owner', 'admin'), handle((req) => rules.update(org(req), req.params.id, req.body)));
router.delete('/:id', requireRole('owner', 'admin'), handle((req) => rules.remove(org(req), req.params.id)));
module.exports = router;
