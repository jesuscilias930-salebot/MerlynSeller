const router = require('express').Router();
const controller = require('../controllers/conversation-analysis.controller');
const { requireUser, requireRole } = require('../middleware/auth.middleware');
router.use(requireUser, requireRole('owner', 'admin'));
router.get('/columns', controller.columns);
router.post('/preview', controller.preview);
router.post('/prepare', controller.prepare);
module.exports = router;
