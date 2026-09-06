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

const entrepreneurPackageSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  caption: z.string().trim().max(1024).nullable().optional(),
  bundleType: z.string().trim().min(1).max(120).nullable().optional(),
  imageCategory: z.string().trim().min(1).max(120).nullable().optional(),
  controlBundleId: z.coerce.number().int().positive().nullable().optional(),
});

const packageResponse = (row) => ({
  id: row.id,
  name: row.name,
  mediaId: row.media_id,
  filename: row.filename,
  caption: row.caption,
  bundleType: row.bundle_type,
  imageCategory: row.image_category,
  controlBundleId: row.control_bundle_id,
  position: row.position,
  created_at: row.created_at,
  updated_at: row.updated_at,
  images: row.images || [],
});

const listPackageRows = async (organizationId) => (await db.query(`
  SELECT p.*, COALESCE(json_agg(json_build_object('id', image.id, 'mediaId', image.media_id, 'filename', image.filename, 'caption', image.caption, 'position', image.position) ORDER BY image.position, image.created_at) FILTER (WHERE image.id IS NOT NULL), '[]'::json) AS images
  FROM entrepreneur_packages p
  LEFT JOIN entrepreneur_package_images image ON image.package_id=p.id
  WHERE p.organization_id=$1
  GROUP BY p.id
  ORDER BY p.position ASC, p.created_at ASC
`, [organizationId])).rows;

exports.listEntrepreneurPackages = async (req, res, next) => {
  try {
    return res.json((await listPackageRows(req.auth.organizationId)).map(packageResponse));
  } catch (error) { return next(error); }
};

exports.createEntrepreneurPackage = async (req, res, next) => {
  try {
    const parsed = entrepreneurPackageSchema.pick({ name: true, bundleType: true, imageCategory: true, controlBundleId: true }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
    const result = await db.query(`INSERT INTO entrepreneur_packages (organization_id, name, bundle_type, image_category, control_bundle_id, position) VALUES ($1,$2,$3,$4,$5,COALESCE((SELECT MAX(position)+1 FROM entrepreneur_packages WHERE organization_id=$1),0)) RETURNING *`, [req.auth.organizationId, parsed.data.name, parsed.data.bundleType || null, parsed.data.imageCategory || null, parsed.data.controlBundleId || null]);
    return res.status(201).json(packageResponse({ ...result.rows[0], images: [] }));
  } catch (error) { return next(error); }
};

exports.uploadEntrepreneurPackage = async (req, res, next) => {
  try {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Package image is required' });
    const contentType = (req.get('content-type') || '').split(';')[0].toLowerCase();
    const filename = decodeURIComponent(req.get('x-upload-filename') || 'paquete-emprendedor');
    const requestedName = decodeURIComponent(req.get('x-package-name') || filename.replace(/\.[^.]+$/, '')).trim();
    const packageId = req.get('x-package-id');
    const requestedCategory = decodeURIComponent(req.get('x-image-category') || '').trim();
    const parsed = entrepreneurPackageSchema.pick({ name: true, imageCategory: true }).safeParse({ name: requestedName, imageCategory: requestedCategory || null });
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
    const uploaded = await messageService.uploadMedia({ buffer: req.body, contentType, filename });
    const result = await db.transaction(async (client) => {
      let groupId = packageId;
      if (groupId) {
        const group = await client.query('SELECT id FROM entrepreneur_packages WHERE id=$1 AND organization_id=$2', [groupId, req.auth.organizationId]);
        if (!group.rows[0]) { const error = new Error('Image collection not found'); error.status = 404; throw error; }
      } else {
        groupId = (await client.query(`INSERT INTO entrepreneur_packages (organization_id, name, image_category, position) VALUES ($1,$2,$3,COALESCE((SELECT MAX(position)+1 FROM entrepreneur_packages WHERE organization_id=$1),0)) RETURNING id`, [req.auth.organizationId, parsed.data.name, parsed.data.imageCategory || null])).rows[0].id;
      }
      const image = await client.query(`INSERT INTO entrepreneur_package_images (package_id, media_id, filename, position) VALUES ($1,$2,$3,COALESCE((SELECT MAX(position)+1 FROM entrepreneur_package_images WHERE package_id=$1),0)) RETURNING id, media_id AS "mediaId", filename, caption, position`, [groupId, uploaded.mediaId, filename]);
      await client.query('UPDATE entrepreneur_packages SET media_id=COALESCE(media_id,$3), filename=COALESCE(filename,$4), updated_at=now() WHERE id=$1 AND organization_id=$2', [groupId, req.auth.organizationId, uploaded.mediaId, filename]);
      return { groupId, image: image.rows[0] };
    });
    return res.status(201).json(result);
  } catch (error) { return next(error); }
};

exports.updateEntrepreneurPackage = async (req, res, next) => {
  try {
    const parsed = entrepreneurPackageSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
    const value = parsed.data;
    const result = await db.query(`
      UPDATE entrepreneur_packages
      SET name=COALESCE($3,name), caption=COALESCE($4,caption), bundle_type=COALESCE($5,bundle_type), control_bundle_id=COALESCE($6,control_bundle_id), image_category=COALESCE($7,image_category), updated_at=now()
      WHERE id=$1 AND organization_id=$2
      RETURNING *
    `, [req.params.id, req.auth.organizationId, value.name, value.caption, value.bundleType, value.controlBundleId, value.imageCategory]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Entrepreneur package not found' });
    return res.json(packageResponse(result.rows[0]));
  } catch (error) { return next(error); }
};

exports.deleteEntrepreneurPackage = async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM entrepreneur_packages WHERE id=$1 AND organization_id=$2 RETURNING id', [req.params.id, req.auth.organizationId]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Entrepreneur package not found' });
    return res.status(204).end();
  } catch (error) { return next(error); }
};

exports.entrepreneurPackageMedia = async (req, res, next) => {
  try {
    const result = await db.query('SELECT media_id FROM entrepreneur_packages WHERE id=$1 AND organization_id=$2', [req.params.id, req.auth.organizationId]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Entrepreneur package not found' });
    const media = await messageService.downloadMedia(result.rows[0].media_id);
    res.set({ 'Content-Type': media.contentType, 'Cache-Control': 'private, max-age=300' });
    return res.send(media.buffer);
  } catch (error) { return next(error); }
};

exports.entrepreneurPackageImageMedia = async (req, res, next) => {
  try {
    const result = await db.query(`SELECT image.media_id FROM entrepreneur_package_images image JOIN entrepreneur_packages p ON p.id=image.package_id WHERE image.id=$1 AND p.organization_id=$2`, [req.params.imageId, req.auth.organizationId]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Image not found' });
    const media = await messageService.downloadMedia(result.rows[0].media_id);
    res.set({ 'Content-Type': media.contentType, 'Cache-Control': 'private, max-age=300' });
    return res.send(media.buffer);
  } catch (error) { return next(error); }
};

exports.listStickers = async (req, res, next) => {
  try { return res.json((await db.query('SELECT id, name, media_id AS "mediaId", filename, position, created_at FROM saved_stickers WHERE organization_id=$1 ORDER BY position, created_at', [req.auth.organizationId])).rows); }
  catch (error) { return next(error); }
};
exports.uploadSticker = async (req, res, next) => {
  try {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Sticker WEBP is required' });
    const filename = decodeURIComponent(req.get('x-upload-filename') || 'sticker.webp').trim();
    const name = decodeURIComponent(req.get('x-sticker-name') || filename.replace(/\.[^.]+$/, '')).trim();
    if (!name || name.length > 120) return res.status(400).json({ error: 'Sticker name is required' });
    const uploaded = await messageService.uploadMedia({ buffer: req.body, contentType: 'image/webp', filename });
    const result = await db.query(`INSERT INTO saved_stickers (organization_id, name, media_id, filename, position) VALUES ($1,$2,$3,$4,COALESCE((SELECT MAX(position)+1 FROM saved_stickers WHERE organization_id=$1),0)) RETURNING id, name, media_id AS "mediaId", filename, position, created_at`, [req.auth.organizationId, name, uploaded.mediaId, filename]);
    return res.status(201).json(result.rows[0]);
  } catch (error) { return next(error); }
};
exports.deleteSticker = async (req, res, next) => {
  try { const result = await db.query('DELETE FROM saved_stickers WHERE id=$1 AND organization_id=$2 RETURNING id', [req.params.id, req.auth.organizationId]); if (!result.rows[0]) return res.status(404).json({ error: 'Sticker not found' }); return res.status(204).end(); }
  catch (error) { return next(error); }
};
exports.stickerMedia = async (req, res, next) => {
  try { const result = await db.query('SELECT media_id FROM saved_stickers WHERE id=$1 AND organization_id=$2', [req.params.id, req.auth.organizationId]); if (!result.rows[0]) return res.status(404).json({ error: 'Sticker not found' }); const media = await messageService.downloadMedia(result.rows[0].media_id); res.set({ 'Content-Type': media.contentType, 'Cache-Control': 'private, max-age=300' }); return res.send(media.buffer); }
  catch (error) { return next(error); }
};
