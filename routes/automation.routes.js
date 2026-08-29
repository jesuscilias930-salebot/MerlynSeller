const router = require('express').Router();
const controller = require('../controllers/automation.controller');
const { requireUser, requireRole } = require('../middleware/auth.middleware');
router.use(requireUser, requireRole('owner', 'admin'));
router.get('/', controller.list);
router.post('/', controller.create);
router.patch('/:id', controller.update);
router.delete('/:id', controller.remove);
module.exports = router;
