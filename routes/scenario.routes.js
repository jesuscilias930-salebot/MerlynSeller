const router = require('express').Router();
const controller = require('../controllers/scenario.controller');
const { requireUser, requireRole } = require('../middleware/auth.middleware');
const isScenarioFile = (req) => ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes((req.get('content-type') || '').split(';')[0].toLowerCase());

router.use(requireUser, requireRole('owner', 'admin'));
router.post('/mcp-session', async (req, res, next) => {
  try { res.set('Cache-Control', 'no-store').status(201).json(await require('../services/scenario-mcp.service').issue(req.auth)); } catch (error) { next(error); }
});
router.delete('/mcp-session', async (req, res, next) => {
  try { await require('../services/scenario-mcp.service').revoke(req.auth); res.sendStatus(204); } catch (error) { next(error); }
});
router.get('/', controller.list);
router.post('/evidence/upload', require('express').raw({ type: isScenarioFile, limit: '25mb' }), controller.uploadEvidence);
router.post('/', controller.create);
router.put('/order', controller.reorder);
router.put('/:id', controller.update);
router.delete('/:id', controller.remove);
module.exports = router;
