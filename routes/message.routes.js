const express = require('express');
const messageController = require('../controllers/message.controller');

const router = express.Router();

router.use(messageController.authenticate);
router.post('/text', messageController.sendText);
router.post('/video', messageController.sendVideo);
router.post('/attachment', messageController.sendAttachment);
router.post('/document', messageController.sendDocument);
router.post('/cta-url', messageController.sendCtaUrl);

module.exports = router;
