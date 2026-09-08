const router = require('express').Router();
const controller = require('../controllers/whatsapp-template.controller');
const { requireUser, requireRole } = require('../middleware/auth.middleware');
router.use(requireUser);
router.get('/', controller.list);
router.post('/sync', requireRole('owner', 'admin'), controller.sync);
router.put('/:id/mappings', requireRole('owner', 'admin'), controller.updateMappings);
module.exports = router;
