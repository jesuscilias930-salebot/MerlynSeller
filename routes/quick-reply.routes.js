const router = require('express').Router();
const controller = require('../controllers/quick-reply.controller');
const { requireUser, requireRole } = require('../middleware/auth.middleware');

router.use(requireUser, requireRole('owner', 'admin'));
router.get('/', controller.list);
router.post('/', controller.create);
router.put('/:id', controller.update);
router.delete('/:id', controller.remove);
module.exports = router;
