const router = require('express').Router();
const { requireUser } = require('../middleware/auth.middleware');
const sales = require('../services/pending-sale.service');

router.use(requireUser);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const handle = (fn) => async (req, res, next) => {
  try { res.json(await fn(req)); }
  catch (error) { if ([400, 404, 409].includes(error.status)) return res.status(error.status).json({ error: error.message }); return next(error); }
};
const org = (req) => req.auth.organizationId;
router.get('/', handle((req) => sales.list(org(req), req.query)));
router.post('/:id/pay', handle((req) => sales.pay(org(req), req.params.id, req.body)));
router.post('/:id/cancel', handle((req) => sales.cancel(org(req), req.params.id)));
module.exports = router;
