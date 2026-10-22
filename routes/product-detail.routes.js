const router = require('express').Router();
const { requireUser } = require('../middleware/auth.middleware');
const details = require('../services/product-detail.service');

router.use(requireUser);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const handle = (run) => async (req, res, next) => {
  try { res.json(await run(req)); }
  catch (error) { if (error.status === 400) return res.status(400).json({ error: error.message }); return next(error); }
};
router.get('/', handle((req) => details.list(req.auth.organizationId)));
// Varias variantes a la vez (p. ej. al crear un modelo con colores y tallas).
router.put('/', handle((req) => details.saveMany(req.auth.organizationId, req.body?.items)));
router.put('/:productId', handle((req) => details.save(req.auth.organizationId, req.params.productId, req.body)));
module.exports = router;
