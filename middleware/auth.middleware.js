const auth = require('../services/auth.service');

exports.requireUser = async (req, res, next) => {
  try {
    const session = await auth.getSession(req.cookies[auth.sessionCookie]);
    if (!session) return res.status(401).json({ error: 'Authentication required' });
    req.auth = session;
    return next();
  } catch (error) {
    return next(error);
  }
};

exports.requireRole = (...roles) => (req, res, next) => (
  roles.includes(req.auth?.user.role) ? next() : res.status(403).json({ error: 'Insufficient permissions' })
);
