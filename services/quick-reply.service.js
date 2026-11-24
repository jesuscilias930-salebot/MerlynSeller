const { z } = require('zod');
const db = require('../lib/db');

const schema = z.object({
  shortcut: z.string().trim().toLowerCase().regex(/^\/[a-z0-9_]{1,40}$/, 'El atajo debe iniciar con / y usar solo letras, números o guion bajo.'),
  name: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(4096),
  kind: z.enum(['text', 'cta_url']).default('text'),
  ctaUrlTemplateId: z.string().uuid().nullable().optional(),
  // Fotos de «Imágenes guardadas» que se envían con el texto (el texto va como pie de la primera).
  imageIds: z.array(z.string().uuid()).max(10, 'Una respuesta rápida puede llevar hasta 10 imágenes.').default([]),
}).superRefine((value, context) => {
  if (value.kind === 'cta_url' && value.imageIds.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['imageIds'], message: 'Una invitación con botón no puede llevar imágenes.' });
  if (value.kind === 'cta_url' && !value.ctaUrlTemplateId) context.addIssue({ code: z.ZodIssueCode.custom, path: ['ctaUrlTemplateId'], message: 'Selecciona una invitación con botón.' });
  if (value.kind === 'text' && value.ctaUrlTemplateId) context.addIssue({ code: z.ZodIssueCode.custom, path: ['ctaUrlTemplateId'], message: 'Una respuesta de texto no puede tener una invitación asociada.' });
});

const parse = (input) => {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const error = new Error(result.error.issues[0].message); error.status = 400; throw error;
};

exports.list = async (organizationId) => (await db.query(
  'SELECT id, shortcut, name, body, kind, cta_url_template_id AS "ctaUrlTemplateId", image_ids AS "imageIds", created_at, updated_at FROM quick_replies WHERE organization_id=$1 ORDER BY shortcut ASC',
  [organizationId],
)).rows;

exports.create = async (organizationId, input) => {
  const value = parse(input);
  if (value.ctaUrlTemplateId) await ensureCtaTemplate(organizationId, value.ctaUrlTemplateId);
  await ensureImages(organizationId, value.imageIds);
  try {
    return (await db.query(
      'INSERT INTO quick_replies (organization_id, shortcut, name, body, kind, cta_url_template_id, image_ids) VALUES ($1,$2,$3,$4,$5,$6,$7::uuid[]) RETURNING id, shortcut, name, body, kind, cta_url_template_id AS "ctaUrlTemplateId", image_ids AS "imageIds", created_at, updated_at',
      [organizationId, value.shortcut, value.name, value.body, value.kind, value.ctaUrlTemplateId || null, value.imageIds],
    )).rows[0];
  } catch (error) {
    if (error.code === '23505') { error.status = 409; error.message = 'Ya existe una respuesta rápida con ese atajo.'; }
    throw error;
  }
};

exports.update = async (organizationId, id, input) => {
  const value = parse(input);
  if (value.ctaUrlTemplateId) await ensureCtaTemplate(organizationId, value.ctaUrlTemplateId);
  await ensureImages(organizationId, value.imageIds);
  try {
    const result = await db.query(
      'UPDATE quick_replies SET shortcut=$3, name=$4, body=$5, kind=$6, cta_url_template_id=$7, image_ids=$8::uuid[], updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING id, shortcut, name, body, kind, cta_url_template_id AS "ctaUrlTemplateId", image_ids AS "imageIds", created_at, updated_at',
      [id, organizationId, value.shortcut, value.name, value.body, value.kind, value.ctaUrlTemplateId || null, value.imageIds],
    );
    if (!result.rows[0]) { const error = new Error('Respuesta rápida no encontrada.'); error.status = 404; throw error; }
    return result.rows[0];
  } catch (error) {
    if (error.code === '23505') { error.status = 409; error.message = 'Ya existe una respuesta rápida con ese atajo.'; }
    throw error;
  }
};

const ensureImages = async (organizationId, imageIds) => {
  if (!imageIds.length) return;
  const result = await db.query('SELECT image.id FROM entrepreneur_package_images image JOIN entrepreneur_packages p ON p.id=image.package_id WHERE p.organization_id=$1 AND image.id = ANY($2::uuid[])', [organizationId, imageIds]);
  if (result.rows.length !== new Set(imageIds).size) { const error = new Error('Una de las imágenes ya no existe en Imágenes guardadas.'); error.status = 400; throw error; }
};

const ensureCtaTemplate = async (organizationId, templateId) => {
  const result = await db.query('SELECT id FROM cta_url_templates WHERE id=$1 AND organization_id=$2', [templateId, organizationId]);
  if (!result.rows[0]) { const error = new Error('La invitación con botón seleccionada no existe.'); error.status = 400; throw error; }
};

exports.remove = async (organizationId, id) => {
  const result = await db.query('DELETE FROM quick_replies WHERE id=$1 AND organization_id=$2 RETURNING id', [id, organizationId]);
  if (!result.rows[0]) { const error = new Error('Respuesta rápida no encontrada.'); error.status = 404; throw error; }
  return { deleted: true };
};
