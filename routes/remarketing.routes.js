const express = require('express');
const controller = require('../controllers/remarketing.controller');
const { requireUser, requireRole } = require('../middleware/auth.middleware');

const router = express.Router();
router.use(requireUser, requireRole('owner', 'admin'));
router.get('/presets', controller.listPresets);
router.post('/presets', controller.savePreset);
router.delete('/presets/:id', controller.removePreset);
router.post('/images', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '5mb' }), controller.uploadImage);
router.post('/campaigns', controller.send);
router.get('/campaigns/preview', controller.previewCampaign);
router.get('/template-campaigns/preview', controller.previewTemplate);
router.post('/template-campaigns', controller.sendTemplate);
router.get('/template-replies/pending', controller.pendingTemplateReplies);
router.post('/template-replies/reprocess', controller.reprocessTemplateReplies);
router.get('/schedule', async (req, res, next) => { try { return res.json(await require('../services/remarketing-schedule.service').get(req.auth.organizationId)); } catch (error) { return error.status ? res.status(error.status).json({ error: error.message }) : next(error); } });
router.put('/schedule', async (req, res, next) => { try { return res.json(await require('../services/remarketing-schedule.service').save(req.auth.organizationId, req.body)); } catch (error) { return error.status ? res.status(error.status).json({ error: error.message }) : next(error); } });
router.get('/move-rules', controller.listMoveRules);
router.put('/move-rules', controller.saveMoveRule);

module.exports = router;
