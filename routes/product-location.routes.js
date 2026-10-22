const router = require('express').Router();
const { requireUser } = require('../middleware/auth.middleware');
const locations = require('../services/product-location.service');
const slots = require('../services/product-location-slot.service');

router.use(requireUser);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.get('/', async (req, res, next) => {
  try { res.json(await locations.list(req.auth.organizationId)); } catch (error) { next(error); }
});
router.put('/', async (req, res, next) => {
  try { res.json(await locations.save(req.auth.organizationId, req.body)); }
  catch (error) { if (error.status === 400) return res.status(400).json({ error: error.message }); return next(error); }
});
// Ubicaciones por talla y color dentro de un producto.
router.get('/slots', async (req, res, next) => {
  try { res.json(await slots.list(req.auth.organizationId)); } catch (error) { next(error); }
});
router.put('/slots/:productId', async (req, res, next) => {
  try { res.json(await slots.replace(req.auth.organizationId, req.params.productId, req.body)); }
  catch (error) { if (error.status === 400) return res.status(400).json({ error: error.message }); return next(error); }
});
module.exports = router;
