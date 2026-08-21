const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhook.controller');

// GET: verificación del webhook (Meta/WhatsApp Cloud API)
router.get('/', webhookController.verify);

// POST: recepción de eventos
router.post('/', webhookController.receive);

module.exports = router;
