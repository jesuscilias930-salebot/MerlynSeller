const { z } = require('zod');
const db = require('../lib/db');
const { outboundQueue } = require('../lib/queue');
const realtime = require('../lib/realtime');

const campaignSchema = z.object({
  columnId: z.string().uuid(),
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

    const total = await client.query(
      'SELECT count(*)::int AS count FROM conversations WHERE organization_id = $1 AND lead_column_id = $2',
      [organizationId, data.columnId],
    );
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
      INSERT INTO remarketing_campaigns (organization_id, lead_column_id, body, image_media_id, image_filename, recipient_count)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `, [organizationId, data.columnId, data.body || null, data.mediaId || null, data.filename || null, eligible.rowCount]);

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
    };
  });

  await Promise.all(result.messageIds.map((messageId) => outboundQueue().add(
    'send-remarketing',
    { messageId },
    { jobId: messageId },
  )));
  await realtime.publish(organizationId, 'remarketing.queued');
  return { campaignId: result.campaignId, queued: result.queued, skipped: result.skipped };
};
