const router = require('express').Router();
const { requireUser } = require('../middleware/auth.middleware');
const chat = require('../services/internal-chat.service');
const realtime = require('../lib/realtime');

router.use(requireUser);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const handle = (fn, status = 200) => async (req, res, next) => {
  try { res.status(status).json(await fn(req)); }
  catch (error) { if (error.status === 400) return res.status(400).json({ error: error.message }); return next(error); }
};
const org = (req) => req.auth.organizationId;
router.get('/messages', handle((req) => chat.messages(org(req), req.query)));
router.get('/unread', handle((req) => chat.unread(org(req))));
router.post('/read', handle((req) => chat.markRead(org(req))));
router.post('/messages', handle(async (req) => {
  const message = await chat.addNote(org(req), req.auth.user?.id, req.body);
  await realtime.publish(org(req), 'internal.updated', null).catch(() => undefined);
  return message;
}, 201));
module.exports = router;
