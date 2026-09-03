const router = require('express').Router();
const controller = require('../controllers/lead.controller');
const { requireUser, requireRole } = require('../middleware/auth.middleware');

router.use(requireUser);
router.get('/board', controller.board);
router.post('/columns', requireRole('owner', 'admin'), controller.addColumn);
router.put('/columns/order', requireRole('owner', 'admin'), controller.reorderColumns);
router.delete('/columns/:id', requireRole('owner', 'admin'), controller.removeColumn);
router.patch('/:id/column', controller.move);

module.exports = router;
