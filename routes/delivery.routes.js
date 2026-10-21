const router = require('express').Router();
const { requireUser } = require('../middleware/auth.middleware');
const deliveries = require('../services/delivery.service');

router.use(requireUser);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const handle = (fn, status = 200) => async (req, res, next) => {
  try { res.status(status).json(await fn(req)); }
  catch (error) { if ([400, 404, 409].includes(error.status)) return res.status(error.status).json({ error: error.message }); return next(error); }
};
const org = (req) => req.auth.organizationId;
router.get('/', handle((req) => deliveries.list(org(req), req.query)));
router.post('/', handle((req) => deliveries.create(org(req), req.body), 201));
router.put('/:id', handle((req) => deliveries.update(org(req), req.params.id, req.body)));
router.patch('/:id/status', handle((req) => deliveries.setStatus(org(req), req.params.id, req.body)));
router.post('/:id/sale', handle((req) => deliveries.recordSale(org(req), req.params.id, req.body)));
router.delete('/:id', handle((req) => deliveries.remove(org(req), req.params.id)));
module.exports = router;
