const { z } = require('zod');
const db = require('../lib/db');
const realtime = require('../lib/realtime');

// Remarketing → mover a columna, configurado por plantilla oficial o mensaje guardado.
//  · Al enviarse el mensaje: mueve el lead como cualquier automatización (respeta los fijados 📌).
//  · Si el lead responde: lo mueve siempre (aunque esté fijado o en otro dashboard) y lo deja fijado.
//    Solo la primera respuesta a cada campaña. Sin columna configurada se usa R-HOT como antes.
const id = z.string().uuid().nullable().optional().transform((value) => value || null);
const schema = z.object({ templateId: id, presetId: id, afterSendColumnId: id, onReplyColumnId: id })
  .refine((value) => Boolean(value.templateId) !== Boolean(value.presetId), 'Elige una plantilla o un mensaje guardado');
const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };

exports.list = async (organizationId) => (await db.query(
  `SELECT template_id AS "templateId", preset_id AS "presetId", after_send_column_id AS "afterSendColumnId", on_reply_column_id AS "onReplyColumnId"
   FROM remarketing_move_rules WHERE organization_id = $1`,
  [organizationId],
)).rows;

exports.save = async (organizationId, input) => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) fail(400, parsed.error.issues[0].message);
  const value = parsed.data;
  const owner = value.templateId
    ? await db.query('SELECT 1 FROM whatsapp_templates WHERE id = $1 AND organization_id = $2', [value.templateId, organizationId])
    : await db.query('SELECT 1 FROM remarketing_presets WHERE id = $1 AND organization_id = $2', [value.presetId, organizationId]);
  if (!owner.rows[0]) fail(404, value.templateId ? 'La plantilla no existe' : 'El mensaje guardado no existe');
  const columns = [value.afterSendColumnId, value.onReplyColumnId].filter(Boolean);
  if (columns.length) {
    const found = await db.query('SELECT count(*)::int AS n FROM lead_columns WHERE organization_id = $1 AND id = ANY($2::uuid[])', [organizationId, columns]);
    if (found.rows[0].n !== new Set(columns).size) fail(400, 'La columna elegida ya no existe');
  }
  const key = value.templateId ? 'template_id' : 'preset_id';
  const keyValue = value.templateId || value.presetId;
  if (!columns.length) {
    await db.query(`DELETE FROM remarketing_move_rules WHERE organization_id = $1 AND ${key} = $2`, [organizationId, keyValue]);
  } else {
    await db.query(
      `INSERT INTO remarketing_move_rules (organization_id, ${key}, after_send_column_id, on_reply_column_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (organization_id, ${key}) WHERE ${key} IS NOT NULL
       DO UPDATE SET after_send_column_id = EXCLUDED.after_send_column_id, on_reply_column_id = EXCLUDED.on_reply_column_id, updated_at = now()`,
      [organizationId, keyValue, value.afterSendColumnId, value.onReplyColumnId],
    );
  }
  return { templateId: value.templateId, presetId: value.presetId, afterSendColumnId: value.afterSendColumnId, onReplyColumnId: value.onReplyColumnId };
};

/** Configuración vigente para una campaña que se está creando (se copia a la campaña). */
exports.forCampaign = async (client, organizationId, { templateId, presetId }) => {
  if (!templateId && !presetId) return { afterSendColumnId: null, onReplyColumnId: null };
  const row = (await client.query(
    `SELECT after_send_column_id AS "afterSendColumnId", on_reply_column_id AS "onReplyColumnId" FROM remarketing_move_rules
     WHERE organization_id = $1 AND ${templateId ? 'template_id' : 'preset_id'} = $2`,
    [organizationId, templateId || presetId],
  )).rows[0];
  return row || { afterSendColumnId: null, onReplyColumnId: null };
};

/** Tras enviarse un mensaje de campaña: mover a la columna «al enviar» (respeta los leads fijados). */
exports.afterSent = async (messageId) => {
  const row = (await db.query(
    `SELECT m.organization_id, m.conversation_id, campaign.after_send_column_id
     FROM messages m JOIN remarketing_campaigns campaign ON campaign.id = m.remarketing_campaign_id
     WHERE m.id = $1 AND campaign.after_send_column_id IS NOT NULL`,
    [messageId],
  )).rows[0];
  if (!row) return false;
  const moved = await db.query(
    `UPDATE conversations SET lead_column_id = $3, updated_at = now()
     WHERE id = $1 AND organization_id = $2 AND column_pinned_at IS NULL AND lead_column_id IS DISTINCT FROM $3 RETURNING id`,
    [row.conversation_id, row.organization_id, row.after_send_column_id],
  );
  if (moved.rows[0]) await realtime.publish(row.organization_id, 'lead.moved', row.conversation_id);
  return Boolean(moved.rows[0]);
};

/** El lead respondió a un remarketing. Devuelve { configured, moved }; sin configuración se usa R-HOT. */
exports.onReply = async (organizationId, conversationId, repliedProviderMessageId) => {
  // La campaña del mensaje citado o, si no citó ninguno, la del último mensaje que le enviamos.
  const campaign = (await db.query(
    `SELECT campaign.id, campaign.on_reply_column_id
     FROM messages m JOIN remarketing_campaigns campaign ON campaign.id = m.remarketing_campaign_id
     WHERE m.organization_id = $1 AND m.conversation_id = $2 AND m.direction = 'outbound'
       AND ($3::text IS NULL OR m.provider_message_id = $3)
       AND ($3::text IS NOT NULL OR m.id = (SELECT id FROM messages WHERE conversation_id = $2 AND direction = 'outbound' ORDER BY created_at DESC LIMIT 1))
     LIMIT 1`,
    [organizationId, conversationId, repliedProviderMessageId || null],
  )).rows[0];
  if (!campaign?.on_reply_column_id) return { configured: false, moved: false };
  const first = await db.query(
    'INSERT INTO remarketing_reply_moves (campaign_id, conversation_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING campaign_id',
    [campaign.id, conversationId],
  );
  if (!first.rows[0]) return { configured: true, moved: false };
  const moved = await db.query(
    `UPDATE conversations SET lead_column_id = $3, column_pinned_at = now(), column_pinned_rule_id = NULL, updated_at = now()
     WHERE id = $1 AND organization_id = $2 RETURNING id`,
    [conversationId, organizationId, campaign.on_reply_column_id],
  );
  if (moved.rows[0]) await realtime.publish(organizationId, 'lead.moved', conversationId);
  return { configured: true, moved: Boolean(moved.rows[0]) };
};
