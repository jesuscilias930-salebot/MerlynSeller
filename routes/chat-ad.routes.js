const router = require('express').Router();
const chatAds = require('../services/chat-ad.service');
const { requireUser, requireRole } = require('../middleware/auth.middleware');

const handle = (action) => async (req, res, next) => {
  try { const result = await action(req); return result === undefined ? res.status(204).end() : res.json(result); }
  catch (error) { return error.status ? res.status(error.status).json({ error: error.message }) : next(error); }
};

router.use(requireUser);
router.get('/', handle((req) => chatAds.list(req.auth.organizationId)));
router.post('/', requireRole('owner', 'admin'), handle((req) => chatAds.create(req.auth.organizationId, req.body)));
router.post('/test', handle((req) => chatAds.test(req.auth.organizationId, req.body?.text)));
router.get('/conversations/:id', handle((req) => chatAds.forConversation(req.auth.organizationId, req.params.id)));
router.put('/:id', requireRole('owner', 'admin'), handle((req) => chatAds.update(req.auth.organizationId, req.params.id, req.body)));
router.delete('/:id', requireRole('owner', 'admin'), handle(async (req) => { await chatAds.remove(req.auth.organizationId, req.params.id); }));
module.exports = router;
