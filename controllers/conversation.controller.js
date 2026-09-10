const conversations = require('../services/conversation.service');
const automations = require('../services/automation.service');
const metaConversions = require('../services/meta-conversions.service');

const handle = (error, res, next) => 
    error.status ? 
res.status(error.status).json(error.toResponse ? error.toResponse() : { error: error.message })
: next(error);

exports.list = async (req, res, next) =>
     {
         try { 
        return res.json(await conversations.list(req.auth.organizationId, req.auth.user.id)); 
    } catch (error) { 
        return handle(error, res, next);
     } 
    };

exports.messages = async (req, res, next) => { 
    try { 
        return res.json(await conversations.messages(req.auth.organizationId, req.params.id, req.auth.user.id));
    } catch (error) { return handle(error, res, next); 

    }
};

exports.documentOptions = async (req, res, next) => {
    try {
        return res.json(await conversations.documentOptions(req.auth.organizationId, req.params.id));
    } catch (error) { return handle(error, res, next); }
};

exports.markRead = async (req, res, next) => {
    try {
        return res.json(await conversations.markRead(req.auth.organizationId, req.auth.user.id, req.params.id));
    } catch (error) { return handle(error, res, next); }
};

exports.setAutoReply = async (req, res, next) => {
    try { return res.json(await conversations.setAutoReply(req.auth.organizationId, req.params.id, req.body)); } catch (error) { return handle(error, res, next); }
};
exports.setScenarioEnabled = async (req, res, next) => { try { return res.json(await conversations.setScenarioEnabled(req.auth.organizationId, req.params.id, req.body)); } catch (error) { return handle(error, res, next); } };
exports.remove = async (req, res, next) => {
    try { return res.json(await conversations.remove(req.auth.organizationId, req.params.id)); } catch (error) { return handle(error, res, next); }
};
exports.deleteMessage = async (req, res, next) => {
    try { return res.json(await conversations.deleteMessage(req.auth.organizationId, req.params.id, req.auth.user.id, req.params.messageId, req.body.scope)); }
    catch (error) { return handle(error, res, next); }
};
exports.learnIntent = async (req, res, next) => {
    try { return res.json(await automations.learnFromMessage(req.auth.organizationId, req.params.id, req.params.messageId, req.body.intentId)); } catch (error) { return handle(error, res, next); }
};
exports.react = async (req, res, next) => {
    try { return res.json(await conversations.reactToMessage(req.auth.organizationId, req.params.id, req.params.messageId, req.body)); }
    catch (error) { return handle(error, res, next); }
};

exports.reportPurchase = async (req, res, next) => {
    try { return res.status(202).json(await metaConversions.reportPurchase(req.auth.organizationId, req.params.id, req.body)); }
    catch (error) { return handle(error, res, next); }
};

exports.create = async (req, res, next) => {
     try { 
        return res.status(201).json(await conversations.create(req.auth.organizationId, req.body)); 
     } catch (error) { return handle(error, res, next); 

     }
};

exports.sendText = async (req, res, next) => {
     try { 
        await conversations.disableScenariosForHuman(req.auth.organizationId, req.params.id);
        return res.status(202).json(await conversations.queueText(req.auth.organizationId, req.params.id, req.body));
     } catch (error) { 
        return handle(error, res, next); 
    } 
};
exports.sendCtaUrl = async (req, res, next) => {
    try { await conversations.disableScenariosForHuman(req.auth.organizationId, req.params.id); return res.status(202).json(await conversations.queueCtaUrl(req.auth.organizationId, req.params.id, req.body)); }
    catch (error) { return handle(error, res, next); }
};
exports.sendTemplate = async (req, res, next) => {
    try { await conversations.disableScenariosForHuman(req.auth.organizationId, req.params.id); return res.status(202).json(await conversations.queueTemplate(req.auth.organizationId, req.params.id, req.body)); }
    catch (error) { return handle(error, res, next); }
};

exports.sendDocument = async (req, res, next) => {
    try {
        await conversations.disableScenariosForHuman(req.auth.organizationId, req.params.id);
        return res.status(202).json(await conversations.queueDocument(req.auth.organizationId, req.params.id, req.body));
    } catch (error) {
        return handle(error, res, next);
    }
};

exports.sendEntrepreneurPackages = async (req, res, next) => {
    try {
        await conversations.disableScenariosForHuman(req.auth.organizationId, req.params.id);
        return res.status(202).json(await conversations.queueEntrepreneurPackages(req.auth.organizationId, req.params.id, req.body));
    } catch (error) { return handle(error, res, next); }
};
exports.sendSavedSticker = async (req, res, next) => {
  try { await conversations.disableScenariosForHuman(req.auth.organizationId, req.params.id); return res.status(202).json(await conversations.queueSavedSticker(req.auth.organizationId, req.params.id, req.body.stickerId)); }
  catch (error) { return handle(error, res, next); }
};

exports.sendAudio = async (req, res, next) => {
    try {
        await conversations.disableScenariosForHuman(req.auth.organizationId, req.params.id);
        const contentType = (req.get('content-type') || '').split(';')[0];
        const filename = decodeURIComponent(req.get('x-upload-filename') || 'audio');
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
            return res.status(400).json({ error: 'Audio file is required' });
        }
        return res.status(202).json(await conversations.queueAudio(req.auth.organizationId, req.params.id, {
            buffer: req.body,
            contentType,
            filename,
        }));
    } catch (error) {
        return handle(error, res, next);
    }
};

const sendMedia = (type) => async (req, res, next) => {
    try {
        await conversations.disableScenariosForHuman(req.auth.organizationId, req.params.id);
        const contentType = (req.get('content-type') || '').split(';')[0];
        const filename = decodeURIComponent(req.get('x-upload-filename') || type);
        const caption = decodeURIComponent(req.get('x-message-caption') || '');
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: `${type} file is required` });
        return res.status(202).json(await conversations.queueMedia(req.auth.organizationId, req.params.id, type, {
            buffer: req.body,
            contentType,
            filename,
            caption: caption || undefined,
        }));
    } catch (error) { return handle(error, res, next); }
};

exports.sendImage = sendMedia('image');
exports.sendVideo = sendMedia('video');

exports.uploadDocument = async (req, res, next) => {
    try {
        await conversations.disableScenariosForHuman(req.auth.organizationId, req.params.id);
        const contentType = (req.get('content-type') || '').split(';')[0];
        const filename = decodeURIComponent(req.get('x-upload-filename') || 'document.pdf');
        const caption = decodeURIComponent(req.get('x-message-caption') || '');
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'PDF file is required' });
        return res.status(202).json(await conversations.queueUploadedDocument(req.auth.organizationId, req.params.id, {
            buffer: req.body,
            contentType,
            filename,
            caption: caption || undefined,
        }));
    } catch (error) { return handle(error, res, next); }
};

exports.media = async (req, res, next) => {
    try {
        const media = await conversations.media(req.auth.organizationId, req.params.id, req.params.messageId);
        res.set({ 'Content-Type': media.contentType, 'Cache-Control': 'private, max-age=300' });
        return res.send(media.buffer);
    } catch (error) {
        return handle(error, res, next);
    }
};
