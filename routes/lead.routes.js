const router = require('express').Router();
const controller = require('../controllers/lead.controller');
const { requireUser, requireRole } = require('../middleware/auth.middleware');

router.use(requireUser);
router.get('/board', controller.board);
router.get('/boards', controller.listBoards);
router.post('/boards', requireRole('owner', 'admin'), controller.createBoard);
router.put('/boards/order', requireRole('owner', 'admin'), controller.reorderBoards);
router.put('/boards/:id', requireRole('owner', 'admin'), controller.updateBoard);
router.delete('/boards/:id', requireRole('owner', 'admin'), controller.removeBoard);
router.post('/columns', requireRole('owner', 'admin'), controller.addColumn);
router.put('/columns/order', requireRole('owner', 'admin'), controller.reorderColumns);
router.delete('/columns/:id', requireRole('owner', 'admin'), controller.removeColumn);
router.patch('/columns/:id/move-leads', requireRole('owner', 'admin'), controller.moveAllFromColumn);
router.patch('/:id/column', controller.move);

module.exports = router;
