const { z } = require('zod');
const db = require('../lib/db');

// Botones rápidos debajo del cuadro de texto del chat: una invitación con enlace (p. ej. al grupo de
// WhatsApp, que el cliente ve como tarjeta con «Unirse») y hasta 5 conjuntos de imágenes guardadas.
const fail = (status, message) => Object.assign(new Error(message), { status });
const label = z.string().trim().min(1, 'Ponle un nombre corto al botón.').max(24, 'El nombre del botón puede tener hasta 24 caracteres.');
// La invitación es un mensaje con enlace escrito aquí, o una de «Invitaciones con botón» ya guardadas.
const invitationSchema = z.object({
  label,
  text: z.string().trim().max(4096).optional().transform((value) => value || undefined),
  ctaUrlTemplateId: z.string().uuid().nullable().optional().transform((value) => value || undefined),
}).superRefine((value, ctx) => {
  if (value.ctaUrlTemplateId) return;
  if (!value.text) ctx.addIssue({ code: 'custom', message: 'Elige una invitación con botón o escribe el mensaje con el enlace.' });
  else if (!/https?:\/\/\S+/i.test(value.text)) ctx.addIssue({ code: 'custom', message: 'La invitación debe incluir el enlace (https://…).' });
}).transform((value) => (value.ctaUrlTemplateId ? { label: value.label, ctaUrlTemplateId: value.ctaUrlTemplateId } : { label: value.label, text: value.text }));
const configSchema = z.object({
  invitation: invitationSchema.nullable().default(null),
  imageButtons: z.array(z.object({ label, packageId: z.string().uuid() })).max(5, 'Puedes configurar hasta 5 botones de imágenes.').default([]),
}).strict();

const parse = (input) => {
  const result = configSchema.safeParse(input || {});
  if (!result.success) throw fail(400, result.error.issues[0].message);
  return result.data;
};

exports.get = async (organizationId) => {
  const row = (await db.query('SELECT config FROM chat_quick_buttons WHERE organization_id=$1', [organizationId])).rows[0];
  if (!row) return { invitation: null, imageButtons: [] };
  try { return parse(row.config); } catch { return { invitation: null, imageButtons: [] }; }
};

exports.save = async (organizationId, input) => {
  const config = parse(input);
  if (config.invitation?.ctaUrlTemplateId) {
    const template = await db.query('SELECT id FROM cta_url_templates WHERE id=$1 AND organization_id=$2', [config.invitation.ctaUrlTemplateId, organizationId]);
    if (!template.rows[0]) throw fail(400, 'La invitación con botón elegida ya no existe.');
  }
  const ids = [...new Set(config.imageButtons.map((button) => button.packageId))];
  if (ids.length) {
    const found = await db.query('SELECT id FROM entrepreneur_packages WHERE organization_id=$1 AND id = ANY($2::uuid[])', [organizationId, ids]);
    if (found.rows.length !== ids.length) throw fail(400, 'Uno de los conjuntos de imágenes ya no existe.');
  }
  await db.query(
    `INSERT INTO chat_quick_buttons (organization_id, config) VALUES ($1,$2::jsonb)
     ON CONFLICT (organization_id) DO UPDATE SET config=EXCLUDED.config, updated_at=now()`,
    [organizationId, JSON.stringify(config)],
  );
  return config;
};

/** Envía la invitación configurada como texto (el enlace se muestra con vista previa). */
exports.sendInvitation = async (organizationId, conversationId) => {
  const { invitation } = await exports.get(organizationId);
  if (!invitation) throw fail(400, 'Primero configura la invitación en Botones rápidos.');
  const conversations = require('./conversation.service');
  if (invitation.ctaUrlTemplateId) {
    const template = (await db.query('SELECT header, header_image_url, body, footer, button_text, url FROM cta_url_templates WHERE id=$1 AND organization_id=$2', [invitation.ctaUrlTemplateId, organizationId])).rows[0];
    if (!template) throw fail(400, 'La invitación con botón ya no existe. Elige otra en Botones rápidos.');
    return conversations.queueCtaUrl(organizationId, conversationId, {
      ...(template.header ? { header: template.header } : {}),
      ...(template.header_image_url ? { headerImageUrl: template.header_image_url } : {}),
      body: template.body,
      ...(template.footer ? { footer: template.footer } : {}),
      buttonText: template.button_text,
      url: template.url,
    });
  }
  return conversations.queueText(organizationId, conversationId, { body: invitation.text });
};
