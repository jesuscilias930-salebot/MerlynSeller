const webhookService = require('../services/webhook.service');

// GET /
exports.verify = (req, res) => {
  const {
    'hub.mode': mode,
    'hub.challenge': challenge,
    'hub.verify_token': token,
  } = req.query;

  if (webhookService.isValidToken(mode, token)) {
    console.log('WEBHOOK VERIFIED');
    return res.status(200).send(challenge);
  }

  res.status(403).end();
};

// POST /
exports.receive = async (req, res) => {
  await webhookService.processEvent(req.body);
  res.status(200).end();
};
