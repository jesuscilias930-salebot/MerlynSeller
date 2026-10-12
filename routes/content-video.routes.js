const router = require('express').Router();
const controller = require('../controllers/content-video.controller');
const { requireUser } = require('../middleware/auth.middleware');

router.use(requireUser);
router.get('/', controller.list);
router.post('/', controller.create);
router.put('/:id', controller.update);
router.patch('/:id/published', controller.setPublished);
router.delete('/:id', controller.remove);
module.exports = router;
