const router = require('express').Router();
const { requireUser } = require('../middleware/auth.middleware');
const loans = require('../services/inventory-loan.service');

router.use(requireUser);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const handle = (fn, status = 200) => async (req, res, next) => {
  try { res.status(status).json(await fn(req)); }
  catch (error) { if ([400, 404].includes(error.status)) return res.status(error.status).json({ error: error.message }); return next(error); }
};
const org = (req) => req.auth.organizationId;
router.get('/', handle((req) => loans.list(org(req), req.query)));
router.post('/', handle((req) => loans.create(org(req), req.auth.user?.id, req.body), 201));
router.put('/:id', handle((req) => loans.update(org(req), req.params.id, req.body)));
router.post('/:id/return', handle((req) => loans.returnItems(org(req), req.params.id, req.body)));
router.delete('/:id', handle((req) => loans.remove(org(req), req.params.id)));
module.exports = router;
