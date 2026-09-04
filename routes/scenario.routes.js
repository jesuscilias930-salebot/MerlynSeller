const router = require('express').Router();
const controller = require('../controllers/scenario.controller');
const { requireUser, requireRole } = require('../middleware/auth.middleware');
const isScenarioFile = (req) => ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes((req.get('content-type') || '').split(';')[0].toLowerCase());

router.use(requireUser, requireRole('owner', 'admin'));
router.get('/', controller.list);
router.post('/evidence/upload', require('express').raw({ type: isScenarioFile, limit: '25mb' }), controller.uploadEvidence);
router.post('/', controller.create);
router.put('/order', controller.reorder);
router.put('/:id', controller.update);
router.delete('/:id', controller.remove);
module.exports = router;
