const router = require('express').Router();
const { requireUser } = require('../middleware/auth.middleware');
const reminders = require('../services/reminder.service');
const realtime = require('../lib/realtime');

router.use(requireUser);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const handle = (fn, status = 200) => async (req, res, next) => {
  try { res.status(status).json(await fn(req)); }
  catch (error) { if ([400, 404, 409].includes(error.status)) return res.status(error.status).json({ error: error.message }); return next(error); }
};
const org = (req) => req.auth.organizationId;
// Un recordatorio con hora pasada se publica de inmediato en el chat interno.
const deliverNow = async (req, result) => {
  try {
    const organizations = await reminders.deliverDue(org(req));
    if (organizations.length) await realtime.publish(org(req), 'internal.updated', null);
  } catch { /* El worker lo publicará en su siguiente revisión. */ }
  return result;
};
router.get('/', handle((req) => reminders.list(org(req), req.query)));
router.post('/', handle(async (req) => deliverNow(req, await reminders.create(org(req), req.auth.user?.id, req.body)), 201));
router.put('/:id', handle(async (req) => deliverNow(req, await reminders.update(org(req), req.params.id, req.body))));
router.patch('/:id/status', handle((req) => reminders.setStatus(org(req), req.params.id, req.body)));
router.delete('/:id', handle((req) => reminders.remove(org(req), req.params.id)));
module.exports = router;
