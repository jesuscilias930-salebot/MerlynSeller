const router = require('express').Router();
const controller = require('../controllers/scenario.controller');
const { requireUser, requireRole } = require('../middleware/auth.middleware');
const isImage = (req) => ['image/jpeg', 'image/png', 'image/webp'].includes((req.get('content-type') || '').split(';')[0].toLowerCase());

router.use(requireUser, requireRole('owner', 'admin'));
router.get('/', controller.list);
router.put('/:key', controller.update);
router.post('/evidence/upload', require('express').raw({ type: isImage, limit: '8mb' }), controller.uploadEvidence);
module.exports = router;
