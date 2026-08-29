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

module.exports = router;
