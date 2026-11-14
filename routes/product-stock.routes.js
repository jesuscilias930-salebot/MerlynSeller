const router = require('express').Router();
const { requireUser } = require('../middleware/auth.middleware');
const productStock = require('../services/product-stock.service');

router.use(requireUser);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
// Productos (modelo · color · género) con tallas disponibles y fotos del E-commerce, para elegir en chats y escenarios.
router.get('/catalog', async (req, res, next) => {
  try { res.json(await productStock.catalog(req.auth.organizationId)); }
  catch (error) { if ([400, 403, 502, 503].includes(error.status)) return res.status(error.status).json({ error: error.message }); return next(error); }
});
module.exports = router;
