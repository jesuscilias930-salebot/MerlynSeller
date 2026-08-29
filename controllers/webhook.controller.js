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
      console.warn(JSON.stringify({ level: 'warn', message: 'Webhook rejected: invalid signature' }));
      return res.status(401).end();
    }

    const summary = webhookService.summarizeEvent(req.body);
    console.log(JSON.stringify({ level: 'info', message: 'Webhook received from Meta', ...summary }));


    const result = await webhookService.processEvent(req.body, req.rawBody);

    if (!result.duplicate && process.env.REDIS_URL) {

      const job = await inboundQueue().add('process-webhook', { payload: req.body });
      console.log(JSON.stringify({ level: 'info', message: 'Webhook queued for processing', jobId: job.id, ...summary }));
      
    } else if (!result.duplicate) {
      console.warn(JSON.stringify({ level: 'warn', message: 'Webhook accepted but not queued: REDIS_URL is not configured', ...summary }));
    }
    
    return res.status(200).json({ received: true, duplicate: result.duplicate });
  } catch (error) {
    return next(error);
  }
};
