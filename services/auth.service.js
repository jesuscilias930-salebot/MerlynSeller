const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const db = require('../lib/db');

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const sessionCookie = 'merlyn_session';

const supabase = () => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) throw new Error('Supabase is not configured');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
};

exports.createSession = async (accessToken) => {
  const { data, error } = await supabase().auth.getUser(accessToken);
  if (error || !data.user) return null;
  const user = data.user;
  const sessionToken = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + Number(process.env.SESSION_TTL_MS || 8 * 60 * 60 * 1000));

  const result = await db.transaction(async (client) => {
    await client.query('INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, updated_at = now()', [user.id, user.email, user.user_metadata?.full_name || user.email]);
    const org = await client.query('INSERT INTO organizations (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id', [`${user.email} workspace`]);
    const organizationId = org.rows[0].id;
    await client.query(`
      INSERT INTO lead_columns (organization_id, name, position)
      VALUES
        ($1, 'Primer contacto', 0),
        ($1, 'Re-Marketing', 1),
        ($1, 'Cotizacion', 2),
        ($1, 'Pendiente envio', 3)
      ON CONFLICT (organization_id, name) DO NOTHING
    `, [organizationId]);
    await client.query('INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (organization_id, user_id) DO NOTHING', [organizationId, user.id, 'owner']);
    await client.query('INSERT INTO app_sessions (token_hash, user_id, organization_id, expires_at) VALUES ($1, $2, $3, $4)', [hash(sessionToken), user.id, organizationId, expiresAt]);
    return { organizationId, user: { id: user.id, email: user.email, role: 'owner' } };
  });
  return { ...result, sessionToken, expiresAt };
};

exports.sessionCookie = sessionCookie;
const requiresCrossSiteCookie = () => process.env.NODE_ENV === 'production' || /^https:\/\//.test(process.env.FRONTEND_ORIGIN || '');

exports.cookieOptions = (expiresAt) => ({
  httpOnly: true,
  secure: requiresCrossSiteCookie(),
  // The deployed UI and API use different Render subdomains. Modern browsers
  // require SameSite=None (with Secure) to include this cookie on UI API calls.
  sameSite: requiresCrossSiteCookie() ? 'none' : 'lax',
  // Chrome can block third-party cookies between separate Render subdomains.
  // Partitioned cookies remain scoped to this UI/API pairing.
  partitioned: requiresCrossSiteCookie(),
  expires: expiresAt,
  path: '/',
});
exports.getSession = async (token) => {
  if (!token) return null;
  const result = await db.query('SELECT s.organization_id, u.id, u.email, m.role FROM app_sessions s JOIN users u ON u.id = s.user_id JOIN memberships m ON m.user_id = u.id AND m.organization_id = s.organization_id WHERE s.token_hash = $1 AND s.expires_at > now()', [hash(token)]);
  return result.rows[0] ? { organizationId: result.rows[0].organization_id, user: { id: result.rows[0].id, email: result.rows[0].email, role: result.rows[0].role } } : null;
};
exports.deleteSession = (token) => token && db.query('DELETE FROM app_sessions WHERE token_hash = $1', [hash(token)]);
