const { z } = require('zod');
const db = require('../lib/db');
const messageService = require('../services/message.service');

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

const templateSchema = z.object({
  filename: z.string().trim().min(1).max(240).optional(),
  caption: z.string().trim().max(1024).nullable().optional(),
  isCatalog: z.boolean().optional(),
});

const syncCatalog = async (client, organizationId, template, clearCatalog = false) => {
  if (clearCatalog) return client.query('DELETE FROM catalog_documents WHERE organization_id = $1', [organizationId]);
  return client.query(`
    INSERT INTO catalog_documents (organization_id, media_id, filename, caption)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (organization_id) DO UPDATE SET media_id=EXCLUDED.media_id, filename=EXCLUDED.filename, caption=EXCLUDED.caption, updated_at=now()
  `, [organizationId, template.media_id, template.filename, template.caption]);
};

exports.listDocumentTemplates = async (req, res, next) => {
  try {
    const result = await db.query(`SELECT id, media_id AS "mediaId", filename, caption, is_catalog AS "isCatalog", created_at, updated_at FROM document_templates WHERE organization_id=$1 ORDER BY is_catalog DESC, updated_at DESC`, [req.auth.organizationId]);
    return res.json(result.rows);
  } catch (error) { return next(error); }
};

exports.uploadDocumentTemplate = async (req, res, next) => {
  try {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'PDF file is required' });
    const filename = decodeURIComponent(req.get('x-upload-filename') || 'documento.pdf').trim();
    if (!/\.pdf$/i.test(filename)) return res.status(400).json({ error: 'Only PDF documents are supported' });
    const uploaded = await messageService.uploadMedia({ buffer: req.body, contentType: 'application/pdf', filename });
    const result = await db.query(`INSERT INTO document_templates (organization_id, media_id, filename) VALUES ($1,$2,$3) RETURNING id, media_id AS "mediaId", filename, caption, is_catalog AS "isCatalog", created_at, updated_at`, [req.auth.organizationId, uploaded.mediaId, filename]);
    return res.status(201).json(result.rows[0]);
  } catch (error) { return next(error); }
};

exports.updateDocumentTemplate = async (req, res, next) => {
  try {
    const parsed = templateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
    const result = await db.transaction(async (client) => {
      const current = await client.query('SELECT * FROM document_templates WHERE id=$1 AND organization_id=$2 FOR UPDATE', [req.params.id, req.auth.organizationId]);
      if (!current.rows[0]) { const error = new Error('Document template not found'); error.status = 404; throw error; }
      const value = parsed.data;
      if (value.isCatalog === true) await client.query('UPDATE document_templates SET is_catalog=false, updated_at=now() WHERE organization_id=$1', [req.auth.organizationId]);
      const updated = await client.query(`UPDATE document_templates SET filename=COALESCE($3, filename), caption=COALESCE($4, caption), is_catalog=COALESCE($5, is_catalog), updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *`, [req.params.id, req.auth.organizationId, value.filename, value.caption, value.isCatalog]);
      // Only touch the automatic catalog setting when the caller explicitly
      // changed it; editing another template must not disable the catalog.
      if (value.isCatalog === true) await syncCatalog(client, req.auth.organizationId, updated.rows[0]);
      if (value.isCatalog === false && current.rows[0].is_catalog) await syncCatalog(client, req.auth.organizationId, updated.rows[0], true);
      return updated.rows[0];
    });
    return res.json({ id: result.id, mediaId: result.media_id, filename: result.filename, caption: result.caption, isCatalog: result.is_catalog, created_at: result.created_at, updated_at: result.updated_at });
  } catch (error) { return next(error); }
};

exports.deleteDocumentTemplate = async (req, res, next) => {
  try {
    await db.transaction(async (client) => {
      const result = await client.query('DELETE FROM document_templates WHERE id=$1 AND organization_id=$2 RETURNING is_catalog', [req.params.id, req.auth.organizationId]);
      if (!result.rows[0]) { const error = new Error('Document template not found'); error.status = 404; throw error; }
      if (result.rows[0].is_catalog) await client.query('DELETE FROM catalog_documents WHERE organization_id=$1', [req.auth.organizationId]);
    });
    return res.status(204).end();
  } catch (error) { return next(error); }
};
