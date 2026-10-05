const router = require('express').Router();
const service = require('../services/scenario-mcp.service');
router.use(async (req, res, next) => {
  try {
    const header = req.get('authorization') || '';
    const auth = await service.authenticate(header.startsWith('Bearer ') ? header.slice(7) : null);
    if (!auth) return res.status(401).json({ error: 'Conexión de escenarios vencida o revocada. Genera un código nuevo en MerlynSeller.' });
    req.scenarioAuth = auth; next();
  } catch (error) { next(error); }
});
const handle = fn => async (req, res, next) => {
  try { res.json(await fn(req)); } catch (error) { if (error.status) res.status(error.status).json({ error: error.message }); else next(error); }
};
router.get('/', handle(req => service.list(req.scenarioAuth.organizationId)));
router.get('/context', handle(req => service.context(req.scenarioAuth.organizationId)));
router.post('/validate', handle(req => service.validate(req.scenarioAuth.organizationId, req.body)));
router.put('/definition', handle(req => service.save(req.scenarioAuth.organizationId, req.body)));
module.exports = router;
