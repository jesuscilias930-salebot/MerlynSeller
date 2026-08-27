const router = require('express').Router();
const controller = require('../controllers/settings.controller');
const { requireUser, requireRole } = require('../middleware/auth.middleware');
router.post('/whatsapp-account', requireUser, requireRole('owner', 'admin'), controller.connectWhatsApp);
module.exports = router;
