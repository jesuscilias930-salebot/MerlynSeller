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
