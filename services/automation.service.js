const { z } = require('zod');
const db = require('../lib/db');
const conversations = require('./conversation.service');

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

const intentSchema = z.object({
  key: z.string().trim().min(2).max(50).regex(/^[a-z0-9_]+$/),
  name: z.string().trim().min(2).max(80),
  responseBody: z.string().trim().max(4096).optional().nullable(),
  action: z.enum(['text', 'send_catalog']),
  examples: z.array(z.string().trim().min(2).max(240)).min(1).max(30),
  isActive: z.boolean().default(true),
  priority: z.number().int().min(0).max(1000).default(0),
}).superRefine((value, ctx) => { if (value.action === 'text' && !value.responseBody) ctx.addIssue({ code: 'custom', message: 'responseBody is required for text automations' }); });
const parse = (input) => { const result = intentSchema.safeParse(input); if (result.success) return result.data; const error = new Error(result.error.issues[0].message); error.status = 400; throw error; };

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

const aiDetect = async (text, intents) => {
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_AUTOMATION_MODEL) return [];
  try {
    const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: process.env.OPENAI_AUTOMATION_MODEL, store: false, instructions: 'Classify the Spanish customer message using only the provided intent keys. Return intent keys that are explicitly requested. Never create keys.', input: `Intents: ${JSON.stringify(intents.map((intent) => ({ key: intent.key, examples: intent.examples })))}\nMessage: ${text}`, text: { format: { type: 'json_schema', name: 'intent_classification', strict: true, schema: { type: 'object', properties: { keys: { type: 'array', items: { type: 'string' } }, confidence: { type: 'number' } }, required: ['keys', 'confidence'], additionalProperties: false } } } }), signal: AbortSignal.timeout(8000) });
    if (!response.ok) return [];
    const body = await response.json(); const parsed = JSON.parse(body.output_text || '{}');
    return parsed.confidence >= 0.8 ? intents.filter((intent) => parsed.keys.includes(intent.key)).map((intent) => ({ intent, confidence: parsed.confidence })) : [];
  } catch { return []; }
};

exports.processIncoming = async (organizationId, conversationId, message) => {
  if (message.type !== 'text' || !message.id) return;
  const [conversation, intents] = await Promise.all([db.query('SELECT auto_reply_enabled FROM conversations WHERE id=$1 AND organization_id=$2', [conversationId, organizationId]), exports.list(organizationId)]);
  if (!conversation.rows[0]?.auto_reply_enabled) return;
  const text = normalize(message.text?.body); if (!text) return;
  const active = intents.filter((intent) => intent.isActive);
  let matches = active.map((intent) => ({ intent, confidence: ruleScore(text, intent.examples || []) })).filter((match) => match.confidence >= 0.72);
  let source = 'rules';
  if (!matches.length) { matches = await aiDetect(text, active); source = matches.length ? 'ai' : 'none'; }
  const unique = [...new Map(matches.sort((a, b) => b.intent.priority - a.intent.priority).map((match) => [match.intent.id, match])).values()];
  const event = await db.query('INSERT INTO automation_events (organization_id, conversation_id, inbound_provider_message_id, detected_intents, source, confidence, outcome) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (inbound_provider_message_id) DO NOTHING RETURNING id', [organizationId, conversationId, message.id, JSON.stringify(unique.map((match) => match.intent.key)), source, unique[0]?.confidence || null, unique.length ? 'queued' : 'no_match']);
  if (!event.rows[0] || !unique.length) return;
  for (const { intent } of unique) {
    if (intent.action === 'send_catalog') {
      const catalog = await db.query('SELECT media_id, filename, caption FROM catalog_documents WHERE organization_id=$1', [organizationId]);
      if (catalog.rows[0]) await conversations.queueDocument(organizationId, conversationId, { mediaId: catalog.rows[0].media_id, filename: catalog.rows[0].filename || undefined, caption: catalog.rows[0].caption || undefined });
    }
    else await conversations.queueText(organizationId, conversationId, { body: intent.responseBody });
  }
};
