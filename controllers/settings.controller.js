const { z } = require('zod');
const db = require('../lib/db');
exports.connectWhatsApp = async (req, res, next) => {
  try {
    const parsed = z.object({ phoneNumberId: z.string().regex(/^\d+$/) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'phoneNumberId must be numeric' });
    if (process.env.WHATSAPP_PHONE_NUMBER_ID && parsed.data.phoneNumberId !== process.env.WHATSAPP_PHONE_NUMBER_ID) return res.status(400).json({ error: 'phoneNumberId does not match this deployment configuration' });
    await db.query('INSERT INTO whatsapp_accounts (phone_number_id, organization_id) VALUES ($1, $2) ON CONFLICT (phone_number_id) DO UPDATE SET organization_id = EXCLUDED.organization_id', [parsed.data.phoneNumberId, req.auth.organizationId]);
    return res.status(204).end();
  } catch (error) { return next(error); }
};
