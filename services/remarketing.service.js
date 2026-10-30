const { z } = require('zod');
const db = require('../lib/db');
const { outboundQueue } = require('../lib/queue');
const realtime = require('../lib/realtime');

const campaignSchema = z.object({
  columnId: z.string().uuid(),
  enableScenarios: z.boolean().optional(),
  // Mensaje guardado usado (si lo hay): define a qué columnas se mueven los leads.
  presetId: z.string().uuid().optional(),
  body: z.string().trim().min(1).max(4096).optional(),
  mediaId: z.string().trim().min(1).max(256).optional(),
  filename: z.string().trim().min(1).max(240).optional(),
}).superRefine((value, context) => {
  if (!value.body && !value.mediaId) context.addIssue({ code: 'custom', message: 'Provide a message, an image, or both' });
  if (value.mediaId && value.body && value.body.length > 1024) context.addIssue({ code: 'custom', message: 'An image caption cannot exceed 1024 characters' });
  if (value.filename && !value.mediaId) context.addIssue({ code: 'custom', message: 'filename requires mediaId' });
});

const presetSchema = z.object({
  name: z.string().trim().min(2).max(100),
  body: z.string().trim().min(1).max(4096).optional(),
  mediaId: z.string().trim().min(1).max(256).optional(),
  filename: z.string().trim().min(1).max(240).optional(),
}).superRefine((value, context) => {
  if (!value.body && !value.mediaId) context.addIssue({ code: 'custom', message: 'Provide a message, an image, or both' });
  if (value.mediaId && value.body && value.body.length > 1024) context.addIssue({ code: 'custom', message: 'An image caption cannot exceed 1024 characters' });
  if (value.filename && !value.mediaId) context.addIssue({ code: 'custom', message: 'filename requires mediaId' });
});

// «Encender escenarios para todos»: prende los escenarios solo en los chats de la columna que
// los tienen pausados (p. ej. los que llegaron por un pedido de la tienda). Devuelve cuántos cambió.
const enableColumnScenarios = async (client, organizationId, columnId) => (await client.query(
  'UPDATE conversations SET scenario_enabled = true WHERE organization_id = $1 AND lead_column_id = $2 AND scenario_enabled = false RETURNING id',
  [organizationId, columnId],
)).rowCount;
exports.enableColumnScenarios = enableColumnScenarios;

const validate = (value) => {
  const parsed = campaignSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const error = new Error(parsed.error.issues[0].message);
  error.status = 400;
  throw error;
};

const validatePreset = (value) => {
  const parsed = presetSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const error = new Error(parsed.error.issues[0].message);
  error.status = 400;
  throw error;
};

exports.listPresets = async (organizationId) => (await db.query(
  'SELECT id, name, body, image_media_id AS "mediaId", image_filename AS filename, updated_at FROM remarketing_presets WHERE organization_id = $1 ORDER BY updated_at DESC',
  [organizationId],
)).rows;

exports.savePreset = async (organizationId, input) => {
  const data = validatePreset(input);
  try {
    const result = await db.query(`
      INSERT INTO remarketing_presets (organization_id, name, body, image_media_id, image_filename)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (organization_id, name) DO UPDATE SET
        body = EXCLUDED.body,
        image_media_id = EXCLUDED.image_media_id,
        image_filename = EXCLUDED.image_filename,
        updated_at = now()
      RETURNING id, name, body, image_media_id AS "mediaId", image_filename AS filename, updated_at
    `, [organizationId, data.name, data.body || null, data.mediaId || null, data.filename || null]);
    return result.rows[0];
  } catch (error) {
    throw error;
  }
};

exports.removePreset = async (organizationId, presetId) => {
  const result = await db.query('DELETE FROM remarketing_presets WHERE id = $1 AND organization_id = $2 RETURNING id', [presetId, organizationId]);
  if (!result.rows[0]) {
    const error = new Error('Remarketing preset not found');
    error.status = 404;
    throw error;
  }
};

exports.queueCampaign = async (organizationId, input) => {
  const data = validate(input);
  const result = await db.transaction(async (client) => {
    const column = await client.query(
      'SELECT id, name FROM lead_columns WHERE id = $1 AND organization_id = $2',
      [data.columnId, organizationId],
    );
    if (!column.rows[0]) {
      const error = new Error('Lead column not found');
      error.status = 404;
      throw error;
    }
    // Solo si se marcó la casilla se revisan y encienden los escenarios de la columna.
    const scenariosEnabled = data.enableScenarios === true ? await enableColumnScenarios(client, organizationId, data.columnId) : 0;

    const total = await client.query(
      'SELECT count(*)::int AS count FROM conversations WHERE organization_id = $1 AND lead_column_id = $2',
      [organizationId, data.columnId],
    );
    const presetId = data.presetId && (await client.query('SELECT id FROM remarketing_presets WHERE id = $1 AND organization_id = $2', [data.presetId, organizationId])).rows[0]?.id || null;
    const moves = await require('./remarketing-move.service').forCampaign(client, organizationId, { presetId });
    const eligible = await client.query(`
      SELECT c.id
      FROM conversations c
      WHERE c.organization_id = $1
        AND c.lead_column_id = $2
        AND EXISTS (
          SELECT 1
          FROM messages incoming
          WHERE incoming.conversation_id = c.id
            AND incoming.direction = 'inbound'
            AND incoming.created_at > now() - interval '24 hours'
        )
    `, [organizationId, data.columnId]);

    const campaign = await client.query(`
      INSERT INTO remarketing_campaigns (organization_id, lead_column_id, lead_column_name, body, image_media_id, image_filename, recipient_count, preset_id, after_send_column_id, on_reply_column_id)
      VALUES ($1, $2, (SELECT name FROM lead_columns WHERE id = $2 AND organization_id = $1), $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
    `, [organizationId, data.columnId, data.body || null, data.mediaId || null, data.filename || null, eligible.rowCount, presetId, moves.afterSendColumnId, moves.onReplyColumnId]);

    const inserted = [];
    for (const conversation of eligible.rows) {
      const message = await client.query(`
        INSERT INTO messages (organization_id, conversation_id, direction, type, body, media_id, status, remarketing_campaign_id)
        VALUES ($1, $2, 'outbound', $3, $4, $5, 'pending', $6)
        RETURNING id
      `, [
        organizationId,
        conversation.id,
        data.mediaId ? 'image' : 'text',
        data.body || null,
        data.mediaId || null,
        campaign.rows[0].id,
      ]);
      inserted.push(message.rows[0].id);
    }

    return {
      campaignId: campaign.rows[0].id,
      messageIds: inserted,
      queued: inserted.length,
      skipped: total.rows[0].count - inserted.length,
      scenariosEnabled,
    };
  });

  await Promise.all(result.messageIds.map((messageId) => outboundQueue().add(
    'send-remarketing',
    { messageId },
    { jobId: messageId },
  )));
  await realtime.publish(organizationId, 'remarketing.queued');
  return { campaignId: result.campaignId, queued: result.queued, skipped: result.skipped, scenariosEnabled: result.scenariosEnabled };
};

// ---- Envío masivo con plantilla oficial ----
// Las plantillas aprobadas llegan aunque hayan pasado las 24 h, así que se envían a todos
// los leads de WhatsApp de la columna. Para evitar envíos dobles se omite a quien ya recibió
// una plantilla de remarketing en las últimas 24 h, y hay un máximo por envío.
const templateCampaignSchema = z.object({
  columnId: z.string().uuid('Elige la columna'),
  templateId: z.string().uuid('Elige la plantilla'),
  manualValues: z.record(z.string(), z.string().max(1024)).default({}),
  enableScenarios: z.boolean().default(false),
});
const MAX_TEMPLATE_RECIPIENTS = () => Math.max(1, Number(process.env.REMARKETING_TEMPLATE_MAX || 1000));
const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };

const templateAudience = async (client, organizationId, columnId) => (await client.query(`
  SELECT c.id, ct.name, ct.phone_number, COALESCE(ct.channel, 'whatsapp') AS channel, c.scenario_enabled = false AS "scenariosPaused",
    EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'outbound' AND m.type = 'template'
      AND m.remarketing_campaign_id IS NOT NULL AND m.created_at > now() - interval '24 hours') AS recent
  FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
  WHERE c.organization_id = $1 AND c.lead_column_id = $2
  ORDER BY c.updated_at DESC
`, [organizationId, columnId])).rows;

/** Cuántos recibirían la plantilla y por qué se omite al resto. */
const audienceSummary = (rows) => {
  const whatsapp = rows.filter((row) => row.channel === 'whatsapp');
  const fresh = whatsapp.filter((row) => !row.recent);
  const max = MAX_TEMPLATE_RECIPIENTS();
  return { total: rows.length, scenariosPaused: rows.filter((row) => row.scenariosPaused).length, eligible: Math.min(fresh.length, max), otherChannel: rows.length - whatsapp.length, recent: whatsapp.length - fresh.length, overLimit: Math.max(0, fresh.length - max), max, recipients: fresh.slice(0, max) };
};
exports.audienceSummary = audienceSummary;

exports.previewTemplateCampaign = async (organizationId, columnId) => {
  if (!z.string().uuid().safeParse(columnId).success) fail(400, 'Elige la columna');
  const { recipients, ...summary } = audienceSummary(await templateAudience(db, organizationId, columnId));
  return summary;
};

exports.queueTemplateCampaign = async (organizationId, input) => {
  const parsed = templateCampaignSchema.safeParse(input);
  if (!parsed.success) fail(400, parsed.error.issues[0].message);
  const { columnId, templateId, manualValues, enableScenarios } = parsed.data;
  const templates = require('./whatsapp-template.service');
  const result = await db.transaction(async (client) => {
    const column = await client.query('SELECT id FROM lead_columns WHERE id = $1 AND organization_id = $2', [columnId, organizationId]);
    if (!column.rows[0]) fail(404, 'La columna no existe');
    // Solo si se marcó la casilla se revisan y encienden los escenarios de la columna.
    const scenariosEnabled = enableScenarios === true ? await enableColumnScenarios(client, organizationId, columnId) : 0;
    const templateRow = (await client.query("SELECT * FROM whatsapp_templates WHERE id=$1 AND organization_id=$2 AND status='APPROVED'", [templateId, organizationId])).rows[0];
    if (!templateRow) fail(404, 'La plantilla aprobada no fue encontrada. Sincroniza tus plantillas.');
    if ((templateRow.components || []).some((component) => String(component.type).toUpperCase() === 'HEADER' && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(String(component.format).toUpperCase())))
      fail(400, 'Esta plantilla lleva imagen, video o documento en el encabezado; por ahora el envío masivo solo admite plantillas de texto.');
    const summary = audienceSummary(await templateAudience(client, organizationId, columnId));
    if (!summary.recipients.length) fail(400, 'No hay leads de WhatsApp en esa columna que puedan recibir la plantilla ahora.');
    const prepared = [];
    let missingData = 0;
    let firstProblem = '';
    for (const row of summary.recipients) {
      try {
        const components = templates.buildComponents(templateRow, row, manualValues);
        prepared.push({ conversationId: row.id, body: JSON.stringify({ templateName: templateRow.name, language: templateRow.language, components, templateId: templateRow.id }) });
      } catch (error) {
        if (!error.status) throw error;
        missingData += 1; firstProblem = firstProblem || error.message;
      }
    }
    if (!prepared.length) fail(400, firstProblem || 'Ningún lead tiene los datos que pide la plantilla.');
    const moves = await require('./remarketing-move.service').forCampaign(client, organizationId, { templateId: templateRow.id });
    const campaign = await client.query(`
      INSERT INTO remarketing_campaigns (organization_id, lead_column_id, lead_column_name, body, recipient_count, template_id, template_name, after_send_column_id, on_reply_column_id)
      VALUES ($1, $2, (SELECT name FROM lead_columns WHERE id = $2 AND organization_id = $1), $3, $4, $5, $6, $7, $8) RETURNING id
    `, [organizationId, columnId, `📋 Plantilla: ${templateRow.name}`, prepared.length, templateRow.id, templateRow.name, moves.afterSendColumnId, moves.onReplyColumnId]);
    const messageIds = [];
    for (const item of prepared) {
      const message = await client.query(`
        INSERT INTO messages (organization_id, conversation_id, direction, type, body, status, remarketing_campaign_id)
        VALUES ($1, $2, 'outbound', 'template', $3, 'pending', $4) RETURNING id
      `, [organizationId, item.conversationId, item.body, campaign.rows[0].id]);
      messageIds.push(message.rows[0].id);
    }
    return { campaignId: campaign.rows[0].id, messageIds, skipped: { otherChannel: summary.otherChannel, recent: summary.recent, overLimit: summary.overLimit, missingData }, firstProblem, scenariosEnabled };
  });
  await Promise.all(result.messageIds.map((messageId) => require('../lib/queue').outboundQueue().add('send-remarketing-template', { messageId }, { jobId: messageId })));
  await realtime.publish(organizationId, 'remarketing.queued');
  return { campaignId: result.campaignId, queued: result.messageIds.length, skipped: result.skipped, scenariosEnabled: result.scenariosEnabled, ...(result.skipped.missingData ? { warning: result.firstProblem } : {}) };
};

// ---- Respuestas a plantillas que quedaron sin atender ----
// Quien tocó un botón de una plantilla de remarketing y no recibió ningún mensaje nuestro después
// (bot o escenarios pausados, fuera de horario, escenario que no arrancó…), aunque luego haya
// escrito algo más. Se pueden volver a procesar.
const pendingReplies = async (organizationId, hours) => (await db.query(`
  SELECT c.id AS "conversationId", c.auto_reply_enabled AS "botEnabled", c.scenario_enabled AS "scenariosEnabled",
    m.provider_message_id AS "messageId", m.type, m.body, m.message_metadata AS metadata
  FROM conversations c
  JOIN LATERAL (SELECT * FROM messages WHERE conversation_id = c.id AND direction = 'inbound' AND type IN ('button', 'interactive')
    AND created_at > now() - make_interval(hours => $2) ORDER BY created_at DESC LIMIT 1) m ON true
  WHERE c.organization_id = $1
    AND NOT EXISTS (SELECT 1 FROM messages o WHERE o.conversation_id = c.id AND o.direction = 'outbound' AND o.created_at > m.created_at)
    AND EXISTS (SELECT 1 FROM messages t WHERE t.conversation_id = c.id AND t.direction = 'outbound' AND t.type = 'template'
      AND t.remarketing_campaign_id IS NOT NULL AND t.created_at > now() - interval '7 days' AND t.created_at < m.created_at)
  ORDER BY m.created_at
  LIMIT 500
`, [organizationId, hours])).rows;
const replyHours = (value) => Math.min(168, Math.max(1, Number(value) || 72));

exports.pendingTemplateReplies = async (organizationId, query = {}) => {
  const rows = await pendingReplies(organizationId, replyHours(query.hours));
  return {
    hours: replyHours(query.hours), pending: rows.length,
    ready: rows.filter((row) => row.botEnabled !== false && row.scenariosEnabled !== false).length,
    // Grupos sin traslape: solo bot pausado, solo escenarios pausados, ambos pausados.
    botPaused: rows.filter((row) => row.botEnabled === false && row.scenariosEnabled !== false).length,
    scenariosPaused: rows.filter((row) => row.botEnabled !== false && row.scenariosEnabled === false).length,
    bothPaused: rows.filter((row) => row.botEnabled === false && row.scenariosEnabled === false).length,
  };
};

exports.reprocessTemplateReplies = async (organizationId, input = {}) => {
  const automations = require('./automation.service');
  const pending = await pendingReplies(organizationId, replyHours(input.hours));
  // Opcional: enciende escenarios y/o bot solo en esos chats para que el catálogo pueda salir.
  const turnOn = async (column, flag, key) => {
    const ids = pending.filter((row) => row[key] === false).map((row) => row.conversationId);
    if (!flag || !ids.length) return 0;
    await db.query(`UPDATE conversations SET ${column} = true WHERE organization_id = $1 AND id = ANY($2::uuid[])`, [organizationId, ids]);
    pending.forEach((row) => { if (ids.includes(row.conversationId)) row[key] = true; });
    return ids.length;
  };
  const scenariosEnabled = await turnOn('scenario_enabled', input.enableScenarios === true, 'scenariosEnabled');
  const botEnabled = await turnOn('auto_reply_enabled', input.enableBot === true, 'botEnabled');
  const rows = pending.filter((row) => row.botEnabled !== false && row.scenariosEnabled !== false);
  let answered = 0;
  for (const row of rows) {
    const button = row.metadata?.button || {};
    const interactive = row.metadata?.interactive || {};
    // Id propio: el registro de automatizaciones no debe tomarlo como un mensaje ya procesado.
    const id = `reprocess:${row.messageId || row.conversationId}:${Date.now()}`;
    const message = row.type === 'button'
      ? { id, type: 'button', button: { text: button.text || row.body, payload: button.payload } }
      : { id, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: interactive.id, title: interactive.title || row.body } } };
    const before = await db.query("SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1 AND direction='outbound'", [row.conversationId]);
    await automations.processIncoming(organizationId, row.conversationId, message, { reprocess: true });
    const after = await db.query("SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1 AND direction='outbound'", [row.conversationId]);
    if (after.rows[0].n > before.rows[0].n) answered += 1;
  }
  if (rows.length) await realtime.publish(organizationId, 'remarketing.queued');
  return { processed: rows.length, answered, unanswered: rows.length - answered, scenariosEnabled, botEnabled, skipped: pending.length - rows.length };
};
