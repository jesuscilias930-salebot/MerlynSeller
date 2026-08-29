const conversations = require('../services/conversation.service');

const handle = (error, res, next) => 
    error.status ? 
res.status(error.status).json({ error: error.message }) 
: next(error);

exports.list = async (req, res, next) =>
     {
         try { 
        return res.json(await conversations.list(req.auth.organizationId)); 
    } catch (error) { 
        return handle(error, res, next);
     } 
    };

exports.messages = async (req, res, next) => { 
    try { 
        return res.json(await conversations.messages(req.auth.organizationId, req.params.id)); 
    } catch (error) { return handle(error, res, next); 

    }
};

exports.create = async (req, res, next) => {
     try { 
        return res.status(201).json(await conversations.create(req.auth.organizationId, req.body)); 
     } catch (error) { return handle(error, res, next); 

     }
};

exports.sendText = async (req, res, next) => {
     try { 
        return res.status(202).json(await conversations.queueText(req.auth.organizationId, req.params.id, req.body));
     } catch (error) { 
        return handle(error, res, next); 
    } 
};

exports.sendDocument = async (req, res, next) => {
    try {
        return res.status(202).json(await conversations.queueDocument(req.auth.organizationId, req.params.id, req.body));
    } catch (error) {
        return handle(error, res, next);
    }
};

exports.sendAudio = async (req, res, next) => {
    try {
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

exports.media = async (req, res, next) => {
    try {
        const media = await conversations.media(req.auth.organizationId, req.params.id, req.params.messageId);
        res.set({ 'Content-Type': media.contentType, 'Cache-Control': 'private, max-age=300' });
        return res.send(media.buffer);
    } catch (error) {
        return handle(error, res, next);
    }
};
