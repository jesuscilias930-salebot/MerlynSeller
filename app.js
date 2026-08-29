require('dotenv').config(); //Injects enviroment variables into process.env

const express = require('express'); //create server and endpoint
const cookieParser = require('cookie-parser'); //Reads browser cookies
const cors = require('cors'); //Allows the ui call to service from other domain

const webhookRoutes = require('./routes/webhook.routes');
const messageRoutes = require('./routes/message.routes');
const authRoutes = require('./routes/auth.routes');
const conversationRoutes = require('./routes/conversation.routes');
const settingsRoutes = require('./routes/settings.routes');
const realtimeRoutes = require('./routes/realtime.routes');
const leadRoutes = require('./routes/lead.routes');
const remarketingRoutes = require('./routes/remarketing.routes');
const automationRoutes = require('./routes/automation.routes');

const realtime = require('./lib/realtime'); //Load the module to conect redis with the conexions SSE de la UI

const app = express();

/*
app.use(...)      // agregar reglas o middleware
app.get(...)      // crear endpoint GET
app.post(...)     // crear endpoint POST
app.listen(...)   // abrir el puerto y empezar a recibir solicitudes
*/

app.disable('x-powered-by');
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || false, credentials: true }));
app.use(cookieParser());

// A SameSite=None session cookie is required when the UI and API are hosted on
// different domains. Reject browser requests from an unexpected Origin before
// they can perform a session-based state change. Requests without an Origin
// remain available for server-to-server integrations and Postman testing.
const browserSessionPaths = ['/auth', '/conversations', '/settings', '/leads', '/remarketing'];
const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
app.use((req, res, next) => {
  const isBrowserSessionRequest = browserSessionPaths.some((path) => req.path === path || req.path.startsWith(`${path}/`));
  const origin = req.get('origin');
  if (isBrowserSessionRequest && unsafeMethods.has(req.method) && origin && origin !== process.env.FRONTEND_ORIGIN) {
    return res.status(403).json({ error: 'Request origin is not allowed' });
  }
  next();
});

if (process.env.NODE_ENV === 'production') {
  const missingSecrets = [
    'VERIFY_TOKEN',
    'META_APP_SECRET',
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_GRAPH_API_VERSION',
    'OUTBOUND_API_KEY',
  ].filter((name) => !process.env[name]);
  if (missingSecrets.length > 0) {
    throw new Error(`Missing required production configuration: ${missingSecrets.join(', ')}`);
  }
  if (process.env.VERIFY_TOKEN.length < 32) {
    throw new Error('VERIFY_TOKEN must be at least 32 characters in production');
  }
}

if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

// Meta signs the exact request bytes. Keep a copy before Express parses JSON.
app.use(express.json({
  limit: process.env.WEBHOOK_MAX_BODY_SIZE || '256kb',
  verify: (req, res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  },
}));

app.use((req, res, next) => {
  res.set({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });

  const requireHttps = process.env.REQUIRE_HTTPS === 'true' || process.env.NODE_ENV === 'production';
  if (requireHttps && !req.secure) {
    return res.status(400).json({ error: 'HTTPS is required' });
  }
  next();
});

app.use('/', webhookRoutes);
app.use('/messages', messageRoutes);
app.use('/auth', authRoutes);
app.use('/conversations', conversationRoutes);
app.use('/settings', settingsRoutes);
app.use('/realtime', realtimeRoutes);
app.use('/leads', leadRoutes);
app.use('/remarketing', remarketingRoutes);
app.use('/automations', automationRoutes);
realtime.start();

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  console.error(JSON.stringify({
    level: 'error',
    message: 'Unhandled webhook request error',
    method: req.method,
    path: req.path,
    errorType: err.name,
    errorMessage: err.message,
  }));
  return res.status(500).json({ error: 'Internal server error' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(JSON.stringify({ level: 'info', message: 'Webhook server listening', port }));
});
