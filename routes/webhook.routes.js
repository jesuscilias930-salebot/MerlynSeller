const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhook.controller');

// GET /health: health check para ECS Express Mode (siempre responde 200)
router.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});


// GET: verificación del webhook (Meta/WhatsApp Cloud API)
router.get('/', webhookController.verify);

// POST: recepción de eventos
router.post('/', webhookController.receive);

module.exports = router;
