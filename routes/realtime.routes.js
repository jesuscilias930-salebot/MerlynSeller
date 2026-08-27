const router = require('express').Router();
const controller = require('../controllers/realtime.controller');
const { requireUser } = require('../middleware/auth.middleware');
router.get('/events', requireUser, controller.stream);
module.exports = router;
