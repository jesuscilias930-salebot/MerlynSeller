const { z } = require('zod');
const db = require('../lib/db');
const conversations = require('./conversation.service');
const scenarios = require('./scenario.service');
const leads = require('./lead.service');

const normalize = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const words = (value) => normalize(value).split(' ').filter((word) => word.length > 1);
const levenshtein = (left, right) => {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = row[0]; row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (left[i - 1] === right[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[right.length];
};
const similarWord = (left, right) => left === right || (left.length >= 4 && right.length >= 4 && levenshtein(left, right) <= Math.max(1, Math.floor(Math.max(left.length, right.length) * 0.25)));
const ruleScore = (text, examples) => Math.max(0, ...examples.map((example) => {
  const normalizedExample = normalize(example);
  if (!normalizedExample) return 0;
  if (text.includes(normalizedExample)) return 1;
  const exampleWords = words(normalizedExample);
  const textWords = words(text);
  const matches = exampleWords.filter((exampleWord) => textWords.some((textWord) => similarWord(exampleWord, textWord))).length;
  return exampleWords.length ? matches / exampleWords.length : 0;
}));
const hasSimilarWord = (text, candidates) => {
  const textWords = words(text);
  return candidates.some((candidate) => textWords.some((word) => similarWord(word, candidate)));
};
const isShippingQuestion = (text) => {
  const shippingMentioned = hasSimilarWord(text, ['envio', 'flete', 'paqueteria', 'mensajeria', 'domicilio']);
  if (!shippingMentioned) return false;
  return hasSimilarWord(text, ['precio', 'costo', 'cuanto', 'sale', 'hacen', 'hace', 'realizan', 'mandan', 'llega', 'ciudad', 'colonia', 'postal', 'republica', 'mexico'])
    || normalize(text).includes('codigo postal');
};
const isExplicitCatalogRequest = (text) => hasSimilarWord(text, ['catalogo', 'catalogue'])
  || normalize(text).includes('lista de productos')
  || normalize(text).includes('ver los productos');
const isExplicitCatalogResend = (text) => {
  const normalized = normalize(text);
  return ['reenvia', 'reenviar', 'mandame de nuevo', 'mandamelo de nuevo', 'manda de nuevo', 'otra vez', 'nuevamente', 'no me llego', 'no puedo abrir', 'no abre'].some((phrase) => normalized.includes(phrase));
};
const isProductPriceQuestion = (text) => {
  if (isShippingQuestion(text) || isExplicitCatalogRequest(text)) return false;
  return hasSimilarWord(text, ['precio', 'precios', 'cuanto', 'costo', 'vale', 'sale']);
};
const isSpecificQuoteRequest = (text) => {
  const normalized = normalize(text);
  return /\b\d+\s*(pares?|docenas?|piezas?|unidades?|calcetas?)\b/.test(normalized)
    || (/\b(docena|docenas)\b/.test(normalized) && /\b(calcetas?|pares?|piezas?)\b/.test(normalized));
};

const intentSchema = z.object({
  key: z.string().trim().min(2).max(50).regex(/^[a-z0-9_]+$/),
  name: z.string().trim().min(2).max(80),
  responseBody: z.string().trim().max(4096).optional().nullable(),
  action: z.enum(['text', 'send_catalog', 'send_shipping_info']),
  examples: z.array(z.string().trim().min(2).max(240)).min(1).max(30),
  isActive: z.boolean().default(true),
  priority: z.number().int().min(0).max(1000).default(0),
}).superRefine((value, ctx) => { if ((value.action === 'text' || value.action === 'send_shipping_info') && !value.responseBody) ctx.addIssue({ code: 'custom', message: 'responseBody is required for this automation' }); });
const parse = (input) => { const result = intentSchema.safeParse(input); if (result.success) return result.data; const error = new Error(result.error.issues[0].message); error.status = 400; throw error; };
const log = (level, message, fields = {}) => console.log(JSON.stringify({ level, message, ...fields }));

const hasReceivedCatalog = async (organizationId, conversationId) => Boolean((await db.query(`
  SELECT EXISTS(
    SELECT 1
    FROM messages message
    JOIN catalog_documents catalog
      ON catalog.organization_id = message.organization_id
     AND catalog.media_id = message.media_id
    WHERE message.organization_id = $1
      AND message.conversation_id = $2
      AND message.direction = 'outbound'
      AND message.type = 'document'
  ) AS "sent"
`, [organizationId, conversationId])).rows[0]?.sent);

const sendShippingInfo = async (organizationId, conversationId, body) => {
  if (!await hasReceivedCatalog(organizationId, conversationId)) {
    const catalog = await db.query('SELECT media_id, filename, caption FROM catalog_documents WHERE organization_id=$1', [organizationId]);
    if (catalog.rows[0]) await conversations.queueDocument(organizationId, conversationId, { mediaId: catalog.rows[0].media_id, filename: catalog.rows[0].filename || undefined, caption: catalog.rows[0].caption || undefined });
    else log('warn', 'Shipping automation could not send catalog: catalog is not configured', { conversationId });
  }
  await conversations.queueText(organizationId, conversationId, { body });
};

exports.list = async (organizationId) => (await db.query('SELECT id, key, name, response_body AS "responseBody", action, examples, is_active AS "isActive", priority, created_at, updated_at FROM automation_intents WHERE organization_id = $1 ORDER BY priority DESC, name ASC', [organizationId])).rows;
exports.create = async (organizationId, input) => {
  const value = parse(input);
  try {
    return (await db.query('INSERT INTO automation_intents (organization_id, key, name, response_body, action, examples, is_active, priority) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, key, name, response_body AS "responseBody", action, examples, is_active AS "isActive", priority', [organizationId, value.key, value.name, value.responseBody || null, value.action, JSON.stringify(value.examples), value.isActive, value.priority])).rows[0];
  } catch (error) { if (error.code === '23505') { error.status = 409; error.message = 'An automation with this key already exists'; } throw error; }
};
exports.update = async (organizationId, id, input) => {
  const value = parse(input);
  const result = await db.query('UPDATE automation_intents SET key=$3,name=$4,response_body=$5,action=$6,examples=$7,is_active=$8,priority=$9,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING id, key, name, response_body AS "responseBody", action, examples, is_active AS "isActive", priority', [id, organizationId, value.key, value.name, value.responseBody || null, value.action, JSON.stringify(value.examples), value.isActive, value.priority]);
  if (!result.rows[0]) { const error = new Error('Automation not found'); error.status = 404; throw error; }
  return result.rows[0];
};
exports.remove = async (organizationId, id) => { const result = await db.query('DELETE FROM automation_intents WHERE id=$1 AND organization_id=$2 RETURNING id', [id, organizationId]); if (!result.rows[0]) { const error = new Error('Automation not found'); error.status = 404; throw error; } return { deleted: true }; };

exports.learnFromMessage = async (organizationId, conversationId, messageId, intentId) => db.transaction(async (client) => {
  const message = await client.query("SELECT body FROM messages WHERE id=$1 AND conversation_id=$2 AND organization_id=$3 AND direction='inbound' AND type='text'", [messageId, conversationId, organizationId]);
  if (!message.rows[0]?.body) { const error = new Error('Only inbound text messages can be used as examples'); error.status = 400; throw error; }
  const intent = await client.query('SELECT id, key, name, examples FROM automation_intents WHERE id=$1 AND organization_id=$2', [intentId, organizationId]);
  if (!intent.rows[0]) { const error = new Error('Automation intent not found'); error.status = 404; throw error; }
  const example = String(message.rows[0].body).trim().slice(0, 240);
  const examples = [...(intent.rows[0].examples || []), example].filter((value, index, values) => value && values.findIndex((candidate) => normalize(candidate) === normalize(value)) === index).slice(-30);
  await client.query('UPDATE automation_intents SET examples=$3, updated_at=now() WHERE id=$1 AND organization_id=$2', [intentId, organizationId, JSON.stringify(examples)]);
  log('info', 'Automation example learned from message', { intentKey: intent.rows[0].key });
  return { learned: true, intentId: intent.rows[0].id, intentName: intent.rows[0].name };
});

const aiDetect = async (text, intents) => {
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_AUTOMATION_MODEL) {
    log('warn', 'Automation AI skipped: OpenAI is not configured', {
      hasApiKey: Boolean(process.env.OPENAI_API_KEY),
      hasModel: Boolean(process.env.OPENAI_AUTOMATION_MODEL),
    });
    return [];
  }
  try {
    log('info', 'Automation AI classification requested', {
      model: process.env.OPENAI_AUTOMATION_MODEL,
      intentCount: intents.length,
    });
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_AUTOMATION_MODEL,
        store: false,
        instructions: 'Classify a Spanish customer message into only the supplied intents. An intent includes its key, name, action, and example phrases. Recognize clear semantic equivalents even with spelling mistakes; do not require literal matches. Treat a request for a catalog, product list, available products, or product options as a catalog request only when the message explicitly asks to see or receive those materials. A question about shipping cost, delivery, freight, city, postal code, or carrier is shipping information, never a catalog request just because it contains the word price. A question about a product price is not a catalog request unless it explicitly asks for the catalog. Select only the most specific applicable intent. Return no keys when the message is unrelated or genuinely ambiguous. Never invent keys.',
        input: JSON.stringify({
          intents: intents.map((intent) => ({ key: intent.key, name: intent.name, action: intent.action, examples: intent.examples })),
          message: text,
        }),
        text: { format: { type: 'json_schema', name: 'intent_classification', strict: true, schema: { type: 'object', properties: { keys: { type: 'array', items: { type: 'string' } }, confidence: { type: 'number' } }, required: ['keys', 'confidence'], additionalProperties: false } } },
      }),
      signal: AbortSignal.timeout(8000),
    });
    const body = await response.json();
    if (!response.ok || body.error) {
      log('warn', 'Automation AI request failed', {
        status: response.status,
        errorCode: body.error?.code || 'unknown',
      });
      return [];
    }
    const parsed = JSON.parse(body.output_text || '{}');
    const matches = parsed.confidence >= 0.8 ? intents.filter((intent) => parsed.keys.includes(intent.key)).map((intent) => ({ intent, confidence: parsed.confidence })) : [];
    log('info', 'Automation AI classification completed', {
      confidence: parsed.confidence || 0,
      matchedIntentCount: matches.length,
    });
    return matches;
  } catch (error) {
    log('warn', 'Automation AI classification failed', { errorType: error.name });
    return [];
  }
};

exports.processIncoming = async (organizationId, conversationId, message) => {
  if (message.type !== 'text' || !message.id) return;
  const [conversation, intents] = await Promise.all([db.query('SELECT auto_reply_enabled FROM conversations WHERE id=$1 AND organization_id=$2', [conversationId, organizationId]), exports.list(organizationId)]);
  if (!conversation.rows[0]?.auto_reply_enabled) return;
  const text = normalize(message.text?.body); if (!text) return;
  // Shipping is a global question: it may be answered without discarding the
  // guided-sales state that was waiting for a different answer. Every other
  // message is owned by the active scenario first.
  const shippingQuestion = isShippingQuestion(text);
  const active = intents.filter((intent) => intent.isActive);
  if (shippingQuestion) {
    const configured = active.find((intent) => intent.action === 'send_shipping_info');
    if (!configured) {
      const moved = await leads.moveToAttention(organizationId, conversationId);
      log('info', 'Shipping question escalated to human attention: no active shipping automation', { conversationId, movedToAttention: moved });
      return;
    }
    await sendShippingInfo(organizationId, conversationId, configured.responseBody);
    log('info', 'Global shipping response sent', { conversationId, configured: true });
    return;
  }
  if (isSpecificQuoteRequest(text)) {
    const moved = await leads.moveToAttention(organizationId, conversationId);
    log('info', 'Specific quote request escalated to human attention', { conversationId, movedToAttention: moved });
    return;
  }
  const scenarioResult = await scenarios.processIncoming(organizationId, conversationId, text);
  if (scenarioResult.handled) return;
  if (scenarioResult.requiresHuman) {
    const moved = await leads.moveToAttention(organizationId, conversationId);
    log('info', 'Scenario escalated to human attention', { conversationId, movedToAttention: moved });
    return;
  }
  const productPriceQuestion = isProductPriceQuestion(text);
  let matches;
  let source;
  {
    matches = active.map((intent) => ({ intent, confidence: ruleScore(text, intent.examples || []) })).filter((match) => match.confidence >= 0.72);
    source = 'rules';
    if (!matches.length) { matches = await aiDetect(text, active); source = matches.length ? 'ai' : 'none'; }
    // A price question can use a dedicated text automation, but cannot cause a
    // document to be sent unless the customer explicitly requested the catalog.
    if (productPriceQuestion) {
      matches = matches.filter(({ intent }) => intent.action !== 'send_catalog');
      if (!matches.length) {
        matches = await aiDetect(text, active.filter((intent) => intent.action !== 'send_catalog'));
        source = matches.length ? 'price_guard_ai' : 'price_guard_no_match';
      }
    }
  }
  const ranked = [...new Map(matches
    .sort((left, right) => right.confidence - left.confidence || right.intent.priority - left.intent.priority)
    .map((match) => [match.intent.id, match])).values()];
  // One inbound message has one primary intent. Shipping itself can send the
  // catalog when it is missing, so separate catalog jobs are never necessary.
  const selected = ranked.slice(0, 1);
  log('info', 'Automation intent evaluated', { source, shippingQuestion, productPriceQuestion, matchedIntentCount: selected.length, selectedIntent: selected[0]?.intent.key || null });
  const event = await db.query('INSERT INTO automation_events (organization_id, conversation_id, inbound_provider_message_id, detected_intents, source, confidence, outcome) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (inbound_provider_message_id) DO NOTHING RETURNING id', [organizationId, conversationId, message.id, JSON.stringify(selected.map((match) => match.intent.key)), source, selected[0]?.confidence || null, selected.length ? 'queued' : 'no_match']);
  if (!event.rows[0]) return;
  if (!selected.length) {
    const moved = await leads.moveToAttention(organizationId, conversationId);
    log('info', 'No automatic answer available', { conversationId, movedToAttention: moved });
    return;
  }
  const { intent } = selected[0];
  if (intent.action === 'send_catalog') {
    const alreadySent = await hasReceivedCatalog(organizationId, conversationId);
    if (alreadySent && !isExplicitCatalogResend(text)) {
      await conversations.queueText(organizationId, conversationId, { body: 'El catálogo ya está en esta conversación. Si no puedes abrirlo, dime y con gusto te lo reenvío.' });
    } else {
      const catalog = await db.query('SELECT media_id, filename, caption FROM catalog_documents WHERE organization_id=$1', [organizationId]);
      if (catalog.rows[0]) await conversations.queueDocument(organizationId, conversationId, { mediaId: catalog.rows[0].media_id, filename: catalog.rows[0].filename || undefined, caption: catalog.rows[0].caption || undefined });
    }
  }
  else if (intent.action === 'send_shipping_info') await sendShippingInfo(organizationId, conversationId, intent.responseBody);
  else await conversations.queueText(organizationId, conversationId, { body: intent.responseBody });
};
