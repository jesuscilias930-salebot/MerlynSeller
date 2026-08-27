const router = require('express').Router();
const controller = require('../controllers/auth.controller');
const { requireUser } = require('../middleware/auth.middleware');
router.post('/session', controller.createSession);
router.delete('/session', controller.logout);
router.get('/me', requireUser, controller.me);
module.exports = router;
