const router = require('express').Router();
const { timingSafeEqual } = require('node:crypto');
const shipping = require('../services/envia-shipping.service');

// Server-to-server only. Fixed organization; callers cannot choose another tenant,
// override origin/environment or purchase labels through this bridge.
let inFlight = 0;
const MAX_CONCURRENT_QUOTES = 8;
router.get('/features', async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const expected = process.env.STORE_SHIPPING_SECRET || '';
  const provided = req.get('X-Store-Shipping-Secret') || '';
  if (expected.length < 32 || !process.env.STORE_ORGANIZATION_ID || req.get('Origin') || Buffer.byteLength(expected) !== Buffer.byteLength(provided) || !timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) return res.sendStatus(401);
  try { res.json(await require('../services/integration-features.service').get(process.env.STORE_ORGANIZATION_ID)); } catch (error) { next(error); }
});
router.post('/quote', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const expected = process.env.STORE_SHIPPING_SECRET || '';
  const provided = req.get('X-Store-Shipping-Secret') || '';
  const org = process.env.STORE_ORGANIZATION_ID;
  if (expected.length < 32 || !org) return res.status(503).json({ error: 'Shipping bridge is not configured' });
  if (req.get('Origin') || Buffer.byteLength(expected) !== Buffer.byteLength(provided) || !timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) return res.sendStatus(401);
  // Per-visitor shared rate limits are enforced by SockControl. Protect upstream
  // capacity separately; a burst must not consume a whole minute for every buyer.
  if (inFlight >= MAX_CONCURRENT_QUOTES) return res.status(429).set('Retry-After', '3').json({error:'Cotizaciones ocupadas; reintenta en unos segundos'});
  inFlight++;
  try {
    const result = await shipping.quoteStore(org, { destination: req.body?.destination, packages: req.body?.packages, settings: { currency: 'MXN' } });
    const rates = result.rates.filter(r => typeof r.carrier === 'string' && typeof r.service === 'string' && r.currency === 'MXN' && Number.isFinite(Number(r.totalPrice)) && Number(r.totalPrice) > 0).map(r => ({
      carrier: r.carrier, service: r.service, description: r.serviceDescription || r.service,
      deliveryEstimate: String(r.deliveryEstimate || (r.deliveryDays ? `${r.deliveryDays} días estimados` : 'Tiempo por confirmar')),
      totalPrice: Number(r.totalPrice), currency: r.currency,
    }));
    return res.json({ environment: result.environment, rates });
  } catch (error) {
    console.warn(JSON.stringify({ level: 'warn', message: 'Store shipping quote failed', status: error.status || 502 }));
    return res.status(502).json({ error: 'No se pudo consultar Envia.com' });
  } finally { inFlight--; }
});
module.exports = router;
