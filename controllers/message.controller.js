const messageService = require('../services/message.service');

const handleMessageError = (error, res, next) => {
  if (error instanceof messageService.MessageError) {
    return res.status(error.status).json(error.toResponse());
  }
  return next(error);
};

exports.authenticate = (req, res, next) => {
  if (!messageService.isOutboundApiKeyValid(req.get('x-api-key'))) {
    const status = process.env.OUTBOUND_API_KEY ? 401 : 503;
    return res.status(status).json({ error: status === 401 ? 'Unauthorized' : 'Outbound messaging is not configured' });
  }
  return next();
};

exports.sendText = async (req, res, next) => {
  try {
    const result = await messageService.sendText(req.body);
    return res.status(202).json(result);
  } catch (error) {
    return handleMessageError(error, res, next);
  }
};

exports.sendVideo = async (req, res, next) => {
  try {
    const result = await messageService.sendVideo(req.body);
    return res.status(202).json(result);
  } catch (error) {
    return handleMessageError(error, res, next);
  }
};

exports.sendAttachment = async (req, res, next) => {
  try {
    const result = await messageService.sendAttachment(req.body);
    return res.status(202).json(result);
  } catch (error) {
    return handleMessageError(error, res, next);
  }
};

exports.sendDocument = async (req, res, next) => {
  try {
    const result = await messageService.sendAttachment({ ...req.body, type: 'document' });
    return res.status(202).json(result);
  } catch (error) {
    return handleMessageError(error, res, next);
  }
};

exports.sendCtaUrl = async (req, res, next) => {
  try {
    const result = await messageService.sendCtaUrl(req.body);
    return res.status(202).json(result);
  } catch (error) {
    return handleMessageError(error, res, next);
  }
};
