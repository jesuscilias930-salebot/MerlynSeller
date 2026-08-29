const { z } = require('zod');
const db = require('../lib/db');
const conversations = require('./conversation.service');
const messageService = require('./message.service');

const normalize = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const hasAny = (text, values) => values.some((value) => text.includes(value));
const isYes = (text) => hasAny(text, ['si', 'sí', 'claro', 'por favor', 'correcto', 'confirmo', 'puedo abrir', 'ya lo abri', 'ya lo abrí', 'me gustaria', 'me gustaría']);
const isCatalogRequest = (text) => hasAny(text, ['catalogo', 'catálogo', 'productos que manejan', 'ver los productos', 'lista de productos']);
const isEntrepreneur = (text) => hasAny(text, ['emprend', 'empezar mi negocio', 'iniciar mi negocio']);
const isShippingRequest = (text) => hasAny(text, ['hacen envios', 'hacen envíos', 'envian a', 'envían a', 'envio a toda', 'envío a toda', 'costo de envio', 'costo de envío']);
const log = (level, message, fields = {}) => console.log(JSON.stringify({ level, message, ...fields }));

const updateSchema = z.object({
  isActive: z.boolean(),
  config: z.object({}).passthrough(),
});

exports.list = async (organizationId) => (await db.query(
  'SELECT id, key, name, is_active AS "isActive", config, updated_at AS "updatedAt" FROM automation_scenarios WHERE organization_id=$1 ORDER BY name',
  [organizationId],
)).rows;

exports.update = async (organizationId, key, input) => {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) { const error = new Error(parsed.error.issues[0].message); error.status = 400; throw error; }
  const result = await db.query(
    'UPDATE automation_scenarios SET is_active=$3, config=$4, updated_at=now() WHERE organization_id=$1 AND key=$2 RETURNING id, key, name, is_active AS "isActive", config, updated_at AS "updatedAt"',
    [organizationId, key, parsed.data.isActive, JSON.stringify(parsed.data.config)],
  );
  if (!result.rows[0]) { const error = new Error('Scenario not found'); error.status = 404; throw error; }
  return result.rows[0];
};

exports.uploadEvidence = async (input) => {
  const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
  if (!allowed.has(input.contentType)) { const error = new Error('Evidence must be a JPEG, PNG, or WebP image'); error.status = 400; throw error; }
  return messageService.uploadMedia(input);
};

const catalog = async (organizationId) => (await db.query('SELECT media_id, filename FROM catalog_documents WHERE organization_id=$1', [organizationId])).rows[0];
const queueCatalog = async (organizationId, conversationId, caption) => {
  const document = await catalog(organizationId);
  if (!document?.media_id) return false;
  await conversations.queueDocument(organizationId, conversationId, { mediaId: document.media_id, filename: document.filename || undefined, caption: caption || undefined });
  return true;
};
const queueEvidence = async (organizationId, conversationId, evidence) => {
  for (const item of evidence || []) {
    if (item?.mediaId) await conversations.queueExistingMedia(organizationId, conversationId, 'image', item.mediaId, item.caption);
  }
};
const setState = async (organizationId, conversationId, scenarioKey, step, context = {}) => db.query(
  `INSERT INTO conversation_scenario_states (organization_id, conversation_id, scenario_key, step, context)
   VALUES ($1,$2,$3,$4,$5)
   ON CONFLICT (conversation_id) WHERE completed_at IS NULL
   DO UPDATE SET scenario_key=EXCLUDED.scenario_key, step=EXCLUDED.step, context=EXCLUDED.context, updated_at=now()`,
  [organizationId, conversationId, scenarioKey, step, JSON.stringify(context)],
);
const finish = async (organizationId, conversationId, columnId) => {
  await db.query('UPDATE conversation_scenario_states SET completed_at=now(), updated_at=now() WHERE conversation_id=$1 AND organization_id=$2 AND completed_at IS NULL', [conversationId, organizationId]);
  if (columnId) await db.query('UPDATE conversations SET lead_column_id=$3, updated_at=now() WHERE id=$1 AND organization_id=$2', [conversationId, organizationId, columnId]);
};
const sendText = (organizationId, conversationId, body) => body ? conversations.queueText(organizationId, conversationId, { body }) : Promise.resolve();

const advanceCatalogAd = async (organizationId, conversationId, state, config, text) => {
  if (state.step === 'await_catalog_confirmation' && isYes(text)) {
    await sendText(organizationId, conversationId, config.goalQuestion);
    await setState(organizationId, conversationId, 'catalogo_anuncio', 'await_goal');
    return true;
  }
  if (state.step === 'await_goal' && isEntrepreneur(text)) {
    await sendText(organizationId, conversationId, config.entrepreneurQuestion);
    await setState(organizationId, conversationId, 'catalogo_anuncio', 'await_catalog_followup');
    return true;
  }
  if (state.step === 'await_catalog_followup' && isCatalogRequest(text)) {
    await sendText(organizationId, conversationId, config.closingMessage);
    await finish(organizationId, conversationId, config.completionColumnId);
    return true;
  }
  return false;
};

const boxText = (box) => [box?.title, box?.description].filter(Boolean).join('\n');
const advanceShipping = async (organizationId, conversationId, state, config, text) => {
  if (state.step === 'await_catalog' && isYes(text)) {
    await queueCatalog(organizationId, conversationId, config.catalogCaption);
    await sendText(organizationId, conversationId, config.goalQuestion);
    await setState(organizationId, conversationId, 'envios_nacionales', 'await_goal');
    return true;
  }
  if (state.step === 'await_goal' && isEntrepreneur(text)) {
    await sendText(organizationId, conversationId, config.entrepreneurQuestion);
    await setState(organizationId, conversationId, 'envios_nacionales', 'await_boxes_confirmation');
    return true;
  }
  if (state.step === 'await_boxes_confirmation' && isYes(text)) {
    for (const box of config.boxes || []) await sendText(organizationId, conversationId, boxText(box));
    await finish(organizationId, conversationId);
    return true;
  }
  return false;
};

exports.processIncoming = async (organizationId, conversationId, text) => {
  const [stateResult, scenarioResult] = await Promise.all([
    db.query('SELECT scenario_key, step, context FROM conversation_scenario_states WHERE conversation_id=$1 AND organization_id=$2 AND completed_at IS NULL', [conversationId, organizationId]),
    exports.list(organizationId),
  ]);
  const scenarios = scenarioResult.rows || scenarioResult;
  const scenarioByKey = new Map(scenarios.filter((scenario) => scenario.isActive).map((scenario) => [scenario.key, scenario]));
  const state = stateResult.rows[0];
  if (state) {
    const scenario = scenarioByKey.get(state.scenario_key);
    if (!scenario) return false;
    const handled = state.scenario_key === 'catalogo_anuncio'
      ? await advanceCatalogAd(organizationId, conversationId, state, scenario.config || {}, text)
      : state.scenario_key === 'envios_nacionales'
        ? await advanceShipping(organizationId, conversationId, state, scenario.config || {}, text)
        : false;
    if (handled) log('info', 'Conversation scenario advanced', { scenario: state.scenario_key, step: state.step });
    return handled;
  }
  const catalogAd = scenarioByKey.get('catalogo_anuncio');
  if (catalogAd && isCatalogRequest(text)) {
    const sent = await queueCatalog(organizationId, conversationId, catalogAd.config?.catalogCaption);
    if (!sent) return false;
    await setState(organizationId, conversationId, catalogAd.key, 'await_catalog_confirmation');
    log('info', 'Conversation scenario started', { scenario: catalogAd.key });
    return true;
  }
  const shipping = scenarioByKey.get('envios_nacionales');
  if (shipping && isShippingRequest(text)) {
    await sendText(organizationId, conversationId, shipping.config?.shippingMessage);
    await queueEvidence(organizationId, conversationId, shipping.config?.evidence);
    await sendText(organizationId, conversationId, shipping.config?.catalogQuestion);
    await setState(organizationId, conversationId, shipping.key, 'await_catalog');
    log('info', 'Conversation scenario started', { scenario: shipping.key });
    return true;
  }
  return false;
};
