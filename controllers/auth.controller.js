const auth = require('../services/auth.service');

exports.createSession = async (req, res, next) => {
  try {
    const session = await auth.createSession(req.body?.accessToken);
    if (!session) return res.status(401).json({ error: 'Invalid Supabase access token' });
    res.cookie(auth.sessionCookie, session.sessionToken, auth.cookieOptions(session.expiresAt));
    return res.status(201).json({ user: session.user, organizationId: session.organizationId });
  } catch (error) { return next(error); }
};
exports.logout = async (req, res, next) => {
  try {
    await auth.deleteSession(req.cookies[auth.sessionCookie]);
    res.clearCookie(auth.sessionCookie, auth.cookieOptions(new Date(0)));
    return res.status(204).end();
  } catch (error) { return next(error); }
};
exports.me = (req, res) => res.json(req.auth);
