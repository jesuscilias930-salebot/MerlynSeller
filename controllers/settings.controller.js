const { z } = require('zod');
const db = require('../lib/db');

const catalogSchema = z.object({
  mediaId: z.string().trim().min(1).max(256),
  filename: z.string().trim().min(1).max(240).optional(),
  caption: z.string().trim().max(1024).optional(),
  triggerPhrase: z.string().trim().min(3).max(200).optional(),
});
exports.connectWhatsApp = async (req, res, next) => {
  try {
    const parsed = z.object({ phoneNumberId: z.string().regex(/^\d+$/) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'phoneNumberId must be numeric' });
    if (process.env.WHATSAPP_PHONE_NUMBER_ID && parsed.data.phoneNumberId !== process.env.WHATSAPP_PHONE_NUMBER_ID) return res.status(400).json({ error: 'phoneNumberId does not match this deployment configuration' });
    await db.query('INSERT INTO whatsapp_accounts (phone_number_id, organization_id) VALUES ($1, $2) ON CONFLICT (phone_number_id) DO UPDATE SET organization_id = EXCLUDED.organization_id', [parsed.data.phoneNumberId, req.auth.organizationId]);
    return res.status(204).end();
  } catch (error) { return next(error); }
};

exports.configureCatalogDocument = async (req, res, next) => {
  try {
    const parsed = catalogSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
    const document = parsed.data;
    await db.query(`
      INSERT INTO catalog_documents (organization_id, media_id, filename, caption, trigger_phrase)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (organization_id) DO UPDATE SET
        media_id = EXCLUDED.media_id,
        filename = EXCLUDED.filename,
        caption = EXCLUDED.caption,
        trigger_phrase = EXCLUDED.trigger_phrase,
        updated_at = now()
    `, [
      req.auth.organizationId,
      document.mediaId,
      document.filename || null,
      document.caption || null,
      document.triggerPhrase || 'quisiera ver el catalogo',
    ]);
    return res.status(204).end();
  } catch (error) { return next(error); }
};
