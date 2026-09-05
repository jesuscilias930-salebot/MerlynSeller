const crypto = require('node:crypto');
const { z } = require('zod');
const db = require('../lib/db');

const purchaseSchema = z.object({
  saleId: z.union([z.string().trim().min(1).max(120), z.number().int().positive()]),
  value: z.coerce.number().finite().positive().max(10_000_000),
  currency: z.string().trim().length(3).optional().default('MXN'),
  itemCount: z.coerce.number().int().positive().max(100_000),
});

const enabled = () => process.env.META_CAPI_ENABLED === 'true';
const config = () => ({
  token: process.env.META_CAPI_ACCESS_TOKEN,
  datasetId: process.env.META_CAPI_DATASET_ID,
  pageId: process.env.META_CAPI_PAGE_ID,
  graphVersion: process.env.META_CAPI_GRAPH_API_VERSION || process.env.WHATSAPP_GRAPH_API_VERSION || 'v25.0',
  testEventCode: process.env.META_CAPI_TEST_EVENT_CODE,
});

const clean = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const eventTime = () => Math.floor(Date.now() / 1000);

const configured = () => {
  const current = config();
  return Boolean(enabled() && current.token && current.datasetId && current.pageId);
};

// Meta's business-messaging CAPI accepts ctwa_clid as the identifying signal
// for Click-to-WhatsApp measurement. It is deliberately not a general CRM
// import: a phone hash or WhatsApp sender id must not be substituted here.
const userData = ({ ctwaClid, pageId }) => ({
  ...(clean(ctwaClid) ? { ctwa_clid: clean(ctwaClid) } : {}),
  ...(clean(pageId) ? { page_id: clean(pageId) } : {}),
});

const endpoint = () => {
  const current = config();
  return `https://graph.facebook.com/${current.graphVersion}/${encodeURIComponent(current.datasetId)}/events?access_token=${encodeURIComponent(current.token)}`;
};

const writeAudit = async ({ organizationId, conversationId, eventName, dedupeKey, payload, status, providerEventId, response, errorMessage }) => {
  const result = await db.query(`
    INSERT INTO meta_conversion_events
      (organization_id, conversation_id, event_name, dedupe_key, provider_event_id, payload, status, response, error_message, sent_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $7='sent' THEN now() ELSE NULL END)
    ON CONFLICT (organization_id, dedupe_key) DO NOTHING
    RETURNING id
  `, [organizationId, conversationId, eventName, dedupeKey, providerEventId, JSON.stringify(payload), status, response ? JSON.stringify(response) : null, errorMessage || null]);
  return result.rowCount > 0;
};

const send = async ({ organizationId, conversationId, eventName, dedupeKey, payload, providerEventId }) => {
  if (!configured()) {
    console.warn(JSON.stringify({ level: 'warn', message: 'Meta CAPI event skipped: configuration is incomplete or disabled', eventName, conversationId }));
    return { sent: false, skipped: true, reason: 'configuration' };
  }

  // Reserve the dedupe key before calling Meta. Browser retries can therefore
  // never report a purchase twice. Failed events remain visible in the audit.
  const reserved = await writeAudit({ organizationId, conversationId, eventName, dedupeKey, payload, providerEventId, status: 'pending' });
  if (!reserved) return { sent: false, duplicate: true };

  const body = { data: [payload] };
  if (config().testEventCode) body.test_event_code = config().testEventCode;
  try {
    const response = await fetch(endpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
    const responseBody = await response.json().catch(() => ({}));
    if (!response.ok) {
      const metaError = responseBody.error || {};
      throw Object.assign(new Error(metaError.error_user_msg || metaError.message || `Meta CAPI responded with HTTP ${response.status}`), { responseBody });
    }
    await db.query("UPDATE meta_conversion_events SET status='sent',response=$2,sent_at=now() WHERE organization_id=$1 AND dedupe_key=$3", [organizationId, JSON.stringify(responseBody), dedupeKey]);
    console.log(JSON.stringify({ level: 'info', message: 'Meta CAPI event sent', eventName, conversationId }));
    return { sent: true };
  } catch (error) {
    await db.query("UPDATE meta_conversion_events SET status='failed',error_message=$2 WHERE organization_id=$1 AND dedupe_key=$3", [organizationId, String(error.message || 'Unknown Meta CAPI error').slice(0, 900), dedupeKey]);
    console.error(JSON.stringify({ level: 'warn', message: 'Meta CAPI event failed', eventName, conversationId, errorMessage: error.message }));
    return { sent: false, error: 'Meta did not accept the conversion event.' };
  }
};

exports.captureInboundReferral = async (organizationId, conversationId, message) => {
  const referral = message?.referral && typeof message.referral === 'object' ? message.referral : null;
  // ctwa_clid is supplied by Meta only for a Click-to-WhatsApp origin. Do not
  // substitute source_id: it identifies the ad source, not the click itself.
  const ctwaClid = clean(referral?.ctwa_clid || referral?.ctwaClid);
  const pageScopedUserId = clean(message?.from);
  if (!ctwaClid) return { sent: false, skipped: true, reason: 'not_attributed_to_ctwa' };

  const result = await db.query(`
    UPDATE conversations SET meta_ctwa_clid=$3,meta_page_scoped_user_id=$4,meta_referral=$5,updated_at=now()
    WHERE id=$1 AND organization_id=$2
    RETURNING id
  `, [conversationId, organizationId, ctwaClid, pageScopedUserId, JSON.stringify(referral)]);
  if (!result.rows[0]) return { sent: false, skipped: true, reason: 'conversation_not_found' };

  const contact = await db.query(`
    SELECT ct.phone_number,c.meta_ctwa_clid,c.meta_page_scoped_user_id
    FROM conversations c JOIN contacts ct ON ct.id=c.contact_id
    WHERE c.id=$1 AND c.organization_id=$2
  `, [conversationId, organizationId]);
  const row = contact.rows[0];
  if (!row) return { sent: false, skipped: true, reason: 'contact_not_found' };
  const providerEventId = crypto.randomUUID();
  const payload = {
    event_name: 'LeadSubmitted',
    event_time: eventTime(),
    event_id: providerEventId,
    action_source: 'business_messaging',
    messaging_channel: 'whatsapp',
    user_data: userData({ ctwaClid: row.meta_ctwa_clid, pageId: config().pageId }),
  };
  const outcome = await send({ organizationId, conversationId, eventName: 'LeadSubmitted', dedupeKey: `lead:${conversationId}`, payload, providerEventId });
  if (outcome.sent) await db.query('UPDATE conversations SET meta_lead_submitted_at=now() WHERE id=$1 AND organization_id=$2', [conversationId, organizationId]);
  return outcome;
};

exports.reportPurchase = async (organizationId, conversationId, input) => {
  const parsed = purchaseSchema.safeParse(input);
  if (!parsed.success) {
    const error = new Error(parsed.error.issues[0].message);
    error.status = 400;
    throw error;
  }
  const data = parsed.data;
  const conversation = await db.query(`
    SELECT c.id,c.meta_ctwa_clid,c.meta_page_scoped_user_id,ct.phone_number
    FROM conversations c JOIN contacts ct ON ct.id=c.contact_id
    WHERE c.id=$1 AND c.organization_id=$2
  `, [conversationId, organizationId]);
  const row = conversation.rows[0];
  if (!row) {
    const error = new Error('Conversation not found');
    error.status = 404;
    throw error;
  }
  // A Purchase reported with action_source=business_messaging is attributable
  // only when the conversation originated from a Click-to-WhatsApp ad. Meta
  // supplies this identifier on the first inbound webhook referral.
  if (!clean(row.meta_ctwa_clid)) {
    console.info(JSON.stringify({ level: 'info', message: 'Meta CAPI Purchase skipped: conversation has no Click-to-WhatsApp attribution', conversationId }));
    return { sent: false, skipped: true, reason: 'not_attributed_to_ctwa' };
  }
  const providerEventId = crypto.randomUUID();
  const saleId = String(data.saleId);
  const payload = {
    event_name: 'Purchase',
    event_time: eventTime(),
    event_id: providerEventId,
    action_source: 'business_messaging',
    messaging_channel: 'whatsapp',
    user_data: userData({ ctwaClid: row.meta_ctwa_clid, pageId: config().pageId }),
    custom_data: {
      currency: data.currency.toUpperCase(),
      value: Number(data.value.toFixed(2)),
      num_items: data.itemCount,
      order_id: saleId,
    },
  };
  return send({ organizationId, conversationId, eventName: 'Purchase', dedupeKey: `purchase:${saleId}`, payload, providerEventId });
};
