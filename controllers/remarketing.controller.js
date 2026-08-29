const { z } = require('zod');
const remarketing = require('../services/remarketing.service');
const messageService = require('../services/message.service');

const handle = (error, res, next) => (error.status
  ? res.status(error.status).json({ error: error.message })
  : next(error));

exports.uploadImage = async (req, res, next) => {
  try {
    const contentType = req.get('content-type') || '';
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
      return res.status(400).json({ error: 'Only JPEG, PNG, and WebP images are supported' });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Image file is required' });
    }
    const filename = z.string().trim().min(1).max(240).safeParse(decodeURIComponent(req.get('x-upload-filename') || 'image'));
    if (!filename.success) return res.status(400).json({ error: filename.error.issues[0].message });
    return res.status(201).json(await messageService.uploadImage({
      buffer: req.body,
      contentType,
      filename: filename.data,
    }));
  } catch (error) {
    return handle(error, res, next);
  }
};

exports.send = async (req, res, next) => {
  try {
    return res.status(202).json(await remarketing.queueCampaign(req.auth.organizationId, req.body));
  } catch (error) {
    return handle(error, res, next);
  }
};
