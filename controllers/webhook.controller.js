const webhookService = require('../services/webhook.service');
const { inboundQueue } = require('../lib/queue');

// GET /
exports.verify = (req, res) => {
  const {
    'hub.mode': mode,
    'hub.challenge': challenge,
    'hub.verify_token': token,
  } = req.query;

  if (webhookService.isValidToken(mode, token)) {
    return res.status(200).send(challenge);
  }

  return res.status(403).end();
};

// POST /
exports.receive = async (req, res, next) => {
  try {
    if (!webhookService.isValidSignature(req.rawBody, req.get('x-hub-signature-256'))) {
      return res.status(401).end();
    }

    const result = await webhookService.processEvent(req.body, req.rawBody);
    if (!result.duplicate && process.env.REDIS_URL) {
      await inboundQueue().add('process-webhook', { payload: req.body });
    }
    return res.status(200).json({ received: true, duplicate: result.duplicate });
  } catch (error) {
    return next(error);
  }
};
