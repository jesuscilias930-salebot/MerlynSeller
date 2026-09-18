const router = require('express').Router();
const { requireUser, requireRole } = require('../middleware/auth.middleware');
const features = require('../services/integration-features.service');
router.use(requireUser, requireRole('owner', 'admin'));
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (req.auth.organizationId !== process.env.STORE_ORGANIZATION_ID) return res.status(403).json({ error: 'Feature solo está disponible para la organización de esta tienda' });
  next();
});
router.get('/', async (req, res, next) => {
  try {
    const modes = await features.get(req.auth.organizationId);
    let stripe = { sandbox: false, production: false }, stripeError = '';
    try { stripe = await features.stripeReadiness(); } catch (error) { stripeError = error.message; }
    res.json({ ...modes, configured: { envia: { sandbox: Boolean(features.enviaToken('sandbox')), production: Boolean(features.enviaToken('production')) }, stripe }, stripeError });
  } catch (error) { next(error); }
});
router.put('/', async (req, res, next) => {
  try { res.json(await features.save(req.auth.organizationId, req.body)); } catch (error) { next(error); }
});
router.use((error, req, res, next) => {
  if (error.status && [400, 403, 503].includes(error.status)) return res.status(error.status).json({ error: error.message });
  next(error);
});
module.exports = router;
