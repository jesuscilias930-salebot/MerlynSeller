const router = require('express').Router();
const { requireUser } = require('../middleware/auth.middleware');
const categories = require('../services/store-category.service');

router.use(requireUser);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.get('/', async (req, res, next) => {
  try { res.json(await categories.list(req.auth.organizationId)); } catch (error) { next(error); }
});
router.put('/', async (req, res, next) => {
  try { res.json(await categories.save(req.auth.organizationId, req.body)); }
  catch (error) { if (error.status === 400) return res.status(400).json({ error: error.message }); return next(error); }
});
module.exports = router;
