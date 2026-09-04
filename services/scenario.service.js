const { z } = require("zod");
const db = require("../lib/db");
const conversations = require("./conversation.service");
const messageService = require("./message.service");

const normalize = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
const words = (value) =>
  normalize(value)
    .split(" ")
    .filter((word) => word.length > 1);
const levenshtein = (left, right) => { const row = Array.from({ length: right.length + 1 }, (_, index) => index); for (let i = 1; i <= left.length; i += 1) { let previous = row[0]; row[0] = i; for (let j = 1; j <= right.length; j += 1) { const current = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (left[i - 1] === right[j - 1] ? 0 : 1)); previous = current; } } return row[right.length]; };
const similar = (left, right) => left === right || (left.length >= 3 && right.length >= 3 && levenshtein(left, right) <= Math.max(1, Math.floor(Math.max(left.length, right.length) * .25)));
const score = (text, examples) =>
  Math.max(
    0,
    ...(examples || []).map((example) => {
      const phrase = normalize(example);
      if (!phrase) return 0;
      if (text.includes(phrase)) return 1;
      const phraseWords = words(phrase);
      const textWords = words(text);
      return phraseWords.length
        ? phraseWords.filter((word) => textWords.some((candidate) => similar(word, candidate))).length /
            phraseWords.length
        : 0;
    }),
  );
const log = (level, message, fields = {}) =>
  console.log(JSON.stringify({ level, message, ...fields }));

const branchSchema = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(100),
  examples: z.array(z.string().trim().min(1).max(240)).min(1).max(30),
  nextStepId: z.string().trim().min(1).max(80),
});
const stepSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z0-9_-]+$/),
  type: z.enum([
    "send_text",
    "send_catalog",
    "send_media",
    "wait_reply",
    "move_column",
    "end",
  ]),
  label: z.string().trim().min(1).max(100),
  body: z.string().max(4096).optional(),
  caption: z.string().max(1024).optional(),
  fallbackBody: z.string().trim().max(4096).optional(),
  resendCatalog: z.boolean().optional(),
  items: z
    .array(
      z.object({
        mediaId: z.string().trim().min(1).max(256),
        filename: z.string().max(240).optional(),
        caption: z.string().max(1024).optional(),
        type: z.enum(["image", "document"]).optional(),
      }),
    )
    .max(20)
    .optional(),
  branches: z.array(branchSchema).max(20).optional(),
  fallbackStepId: z.string().trim().min(1).max(80).optional(),
  nextStepId: z.string().trim().min(1).max(80).optional(),
  columnId: z.string().uuid().optional().or(z.literal("")),
});
const scenarioSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    triggerExamples: z.array(z.string().trim().min(2).max(240)).min(1).max(30),
    aiDescription: z.string().trim().min(10).max(700).optional().nullable(),
    priority: z.number().int().min(0).max(1000).default(0),
    canInterrupt: z.boolean().default(true),
    isActive: z.boolean().default(true),
    steps: z.array(stepSchema).min(1).max(60),
  })
  .superRefine((value, ctx) => {
    const ids = new Set();
    for (const [index, step] of value.steps.entries()) {
      if (ids.has(step.id))
        ctx.addIssue({
          code: "custom",
          message: `Duplicate step id: ${step.id}`,
        });
      ids.add(step.id);
      if (step.type === "send_text" && !step.body?.trim())
        ctx.addIssue({
          code: "custom",
          message: `Step ${index + 1} needs text`,
        });
      if (step.type === "wait_reply" && !step.branches?.length)
        ctx.addIssue({
          code: "custom",
          message: `Step ${index + 1} needs at least one answer branch`,
        });
    }
    const references = value.steps
      .flatMap((step) => [
        step.nextStepId,
        step.fallbackStepId,
        ...(step.branches || []).map((branch) => branch.nextStepId),
      ])
      .filter(Boolean);
    for (const id of references)
      if (!ids.has(id))
        ctx.addIssue({
          code: "custom",
          message: `Step reference not found: ${id}`,
        });
  });
const parse = (input) => {
  const result = scenarioSchema.safeParse(input);
  if (result.success) return result.data;
  const error = new Error(result.error.issues[0].message);
  error.status = 400;
  throw error;
};
const toRow = (row) => ({
  ...row,
  triggerExamples: row.triggerExamples || [],
  steps: row.steps || [],
});
const slug = (name) =>
  normalize(name)
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 40) || "scenario";

exports.list = async (organizationId) =>
  (
    await db.query(
      'SELECT id,key,name,is_active AS "isActive",trigger_examples AS "triggerExamples",ai_description AS "aiDescription",priority,can_interrupt AS "canInterrupt",position,steps,updated_at AS "updatedAt" FROM automation_scenarios WHERE organization_id=$1 ORDER BY position ASC, created_at ASC',
      [organizationId],
    )
  ).rows.map(toRow);
exports.create = async (organizationId, input) => {
  const value = parse(input);
  const base = slug(value.name);
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const key = suffix ? `${base}_${suffix + 1}` : base;
    try {
      const result = await db.query(
        'INSERT INTO automation_scenarios (organization_id,key,name,is_active,trigger_examples,ai_description,priority,can_interrupt,position,steps,config) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE((SELECT MAX(position)+1 FROM automation_scenarios WHERE organization_id=$1),0),$9,\'{}\') RETURNING id,key,name,is_active AS "isActive",trigger_examples AS "triggerExamples",ai_description AS "aiDescription",priority,can_interrupt AS "canInterrupt",position,steps,updated_at AS "updatedAt"',
        [
          organizationId,
          key,
          value.name,
          value.isActive,
          JSON.stringify(value.triggerExamples),
          value.aiDescription || null, value.priority, value.canInterrupt, JSON.stringify(value.steps),
        ],
      );
      return toRow(result.rows[0]);
    } catch (error) {
      if (error.code !== "23505") throw error;
    }
  }
  const error = new Error("Could not create a unique scenario key");
  error.status = 409;
  throw error;
};
exports.update = async (organizationId, id, input) => {
  const value = parse(input);
  const result = await db.query(
    'UPDATE automation_scenarios SET name=$3,is_active=$4,trigger_examples=$5,ai_description=$6,priority=$7,can_interrupt=$8,steps=$9,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING id,key,name,is_active AS "isActive",trigger_examples AS "triggerExamples",ai_description AS "aiDescription",priority,can_interrupt AS "canInterrupt",position,steps,updated_at AS "updatedAt"',
    [
      id,
      organizationId,
      value.name,
      value.isActive,
      JSON.stringify(value.triggerExamples),
      value.aiDescription || null, value.priority, value.canInterrupt, JSON.stringify(value.steps),
    ],
  );
  if (!result.rows[0]) {
    const error = new Error("Scenario not found");
    error.status = 404;
    throw error;
  }
  return toRow(result.rows[0]);
};
exports.reorder = async (organizationId, input) => {
  const ids = z.array(z.string().uuid()).min(1).max(100).safeParse(input?.scenarioIds);
  if (!ids.success) { const error = new Error('scenarioIds must include every scenario'); error.status = 400; throw error; }
  await db.transaction(async (client) => {
    const existing = await client.query('SELECT id FROM automation_scenarios WHERE organization_id=$1 FOR UPDATE', [organizationId]);
    const expected = new Set(existing.rows.map((row) => row.id));
    const received = new Set(ids.data);
    if (expected.size !== received.size || [...expected].some((id) => !received.has(id))) {
      const error = new Error('The scenario order must include every scenario exactly once'); error.status = 400; throw error;
    }
    await client.query(`UPDATE automation_scenarios AS scenario SET position=ordered.position - 1 FROM unnest($2::uuid[]) WITH ORDINALITY AS ordered(id,position) WHERE scenario.organization_id=$1 AND scenario.id=ordered.id`, [organizationId, ids.data]);
  });
  return { scenarioIds: ids.data };
};
exports.remove = async (organizationId, id) =>
  db.transaction(async (client) => {
    const scenario = await client.query(
      "DELETE FROM automation_scenarios WHERE id=$1 AND organization_id=$2 RETURNING key",
      [id, organizationId],
    );
    if (!scenario.rows[0]) {
      const error = new Error("Scenario not found");
      error.status = 404;
      throw error;
    }
    await client.query(
      "UPDATE conversation_scenario_states SET completed_at=now(),updated_at=now() WHERE organization_id=$1 AND scenario_key=$2 AND completed_at IS NULL",
      [organizationId, scenario.rows[0].key],
    );
    return { deleted: true };
  });
exports.uploadEvidence = async (input) => {
  const allowed = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "application/pdf",
  ]);
  if (!allowed.has(input.contentType)) {
    const error = new Error("Scenario files must be JPEG, PNG, WebP, or PDF");
    error.status = 400;
    throw error;
  }
  return messageService.uploadMedia(input);
};

const hasSentCatalog = async (organizationId, conversationId) => Boolean((await db.query(`
  SELECT EXISTS(
    SELECT 1 FROM messages message
    JOIN catalog_documents catalog
      ON catalog.organization_id=message.organization_id
     AND catalog.media_id=message.media_id
    WHERE message.organization_id=$1
      AND message.conversation_id=$2
      AND message.direction='outbound'
      AND message.type='document'
  ) AS sent
`, [organizationId, conversationId])).rows[0]?.sent);
const queueCatalog = async (organizationId, conversationId, caption, force = false) => {
  const document = (
    await db.query(
      "SELECT media_id,filename FROM catalog_documents WHERE organization_id=$1",
      [organizationId],
    )
  ).rows[0];
  if (!document?.media_id) {
    const error = new Error("No catalog document is configured");
    error.status = 400;
    throw error;
  }
  if (!force && await hasSentCatalog(organizationId, conversationId)) return false;
  await conversations.queueDocument(organizationId, conversationId, {
    mediaId: document.media_id,
    filename: document.filename || undefined,
    caption: caption || undefined,
  });
  return true;
};
const setCurrentStep = async (
  organizationId,
  conversationId,
  scenarioKey,
  stepId,
) =>
  db.query(
    `INSERT INTO conversation_scenario_states (organization_id,conversation_id,scenario_key,step,context) VALUES ($1,$2,$3,$4,'{}') ON CONFLICT (conversation_id) WHERE completed_at IS NULL DO UPDATE SET scenario_key=EXCLUDED.scenario_key,step=EXCLUDED.step,updated_at=now()`,
    [organizationId, conversationId, scenarioKey, stepId],
  );
const complete = (organizationId, conversationId) =>
  db.query(
    "UPDATE conversation_scenario_states SET completed_at=now(),updated_at=now() WHERE organization_id=$1 AND conversation_id=$2 AND completed_at IS NULL",
    [organizationId, conversationId],
  );
const byId = (scenario, id) => scenario.steps.find((step) => step.id === id);
const aiMatchScenario = async (text, scenarios) => {
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_AUTOMATION_MODEL || !scenarios.length) return null;
  try {
    const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: process.env.OPENAI_AUTOMATION_MODEL, store: false, instructions: 'Classify the Spanish customer message into at most one scenario. Handle common typos. Return no key if ambiguous. Select only when the scenario clearly matches the meaning.', input: JSON.stringify({ message: text, scenarios: scenarios.map((scenario) => ({ key: scenario.key, name: scenario.name, description: scenario.aiDescription || '', examples: scenario.triggerExamples })) }), text: { format: { type: 'json_schema', name: 'scenario_match', strict: true, schema: { type: 'object', properties: { key: { type: ['string', 'null'] }, confidence: { type: 'number' } }, required: ['key', 'confidence'], additionalProperties: false } } } }), signal: AbortSignal.timeout(8000) });
    const body = await response.json(); if (!response.ok || body.error) return null;
    const parsed = JSON.parse(body.output_text || '{}');
    return parsed.confidence >= .82 ? scenarios.find((scenario) => scenario.key === parsed.key) || null : null;
  } catch (error) { log('warn', 'Scenario AI classification failed', { errorType: error.name }); return null; }
};

const run = async (
  organizationId,
  conversationId,
  scenario,
  stepId,
  depth = 0,
) => {
  if (depth > 12) {
    const error = new Error(
      "Scenario contains too many automatic consecutive steps",
    );
    error.status = 400;
    throw error;
  }
  const step = byId(scenario, stepId);
  if (!step) {
    const error = new Error("Scenario step not found");
    error.status = 400;
    throw error;
  }
  if (step.type === "wait_reply") {
    await setCurrentStep(organizationId, conversationId, scenario.key, step.id);
    return;
  }
  if (step.type === "end") {
    await complete(organizationId, conversationId);
    return;
  }
  if (step.type === "send_text")
    await conversations.queueText(organizationId, conversationId, {
      body: step.body,
    });
  if (step.type === "send_catalog") {
    const sent = await queueCatalog(organizationId, conversationId, step.caption, step.resendCatalog === true);
    if (!sent) await conversations.queueText(organizationId, conversationId, { body: "El catálogo ya está en esta conversación. Si no puedes abrirlo, dime y con gusto te lo reenvío." });
  }
  if (step.type === "send_media")
    for (const item of step.items || []) {
      if (item.type === "document")
        await conversations.queueDocument(organizationId, conversationId, {
          mediaId: item.mediaId,
          filename: item.filename || undefined,
          caption: item.caption || undefined,
        });
      else
        await conversations.queueExistingMedia(
          organizationId,
          conversationId,
          "image",
          item.mediaId,
          item.caption,
        );
    }
  if (step.type === "move_column" && step.columnId)
    await db.query(
      "UPDATE conversations SET lead_column_id=$3,updated_at=now() WHERE id=$1 AND organization_id=$2",
      [conversationId, organizationId, step.columnId],
    );
  if (step.nextStepId)
    return run(
      organizationId,
      conversationId,
      scenario,
      step.nextStepId,
      depth + 1,
    );
  return complete(organizationId, conversationId);
};

exports.processIncoming = async (organizationId, conversationId, incoming) => {
  const text = normalize(incoming);
  if (!text) return false;
  const [states, scenarios, conversation] = await Promise.all([
    db.query(
      "SELECT scenario_key,step FROM conversation_scenario_states WHERE organization_id=$1 AND conversation_id=$2 AND completed_at IS NULL",
      [organizationId, conversationId],
    ),
    exports.list(organizationId),
    db.query('SELECT scenario_enabled FROM conversations WHERE id=$1 AND organization_id=$2', [conversationId, organizationId]),
  ]);
  if (conversation.rows[0]?.scenario_enabled === false) return false;
  const active = scenarios.filter((scenario) => scenario.isActive);
  const state = states.rows[0];
  const rankedStarts = active.map((scenario) => ({ scenario, value: score(text, scenario.triggerExamples) })).sort((a, b) => b.value - a.value || a.scenario.position - b.scenario.position || b.scenario.priority - a.scenario.priority);
  let newStart = rankedStarts[0]?.value >= .72 ? rankedStarts[0].scenario : null;
  if (!newStart) newStart = await aiMatchScenario(text, active);
  if (state) {
    const scenario = active.find((item) => item.key === state.scenario_key);
    const step = scenario && byId(scenario, state.step);
    if (!scenario || !step || step.type !== "wait_reply") return false;
    // A clearly recognized, interruptible scenario replaces the current wait.
    // Weak matches never cancel a lead's ongoing guided conversation.
    if (newStart && newStart.key !== scenario.key && newStart.canInterrupt) {
      await complete(organizationId, conversationId);
      await run(organizationId, conversationId, newStart, newStart.steps[0].id);
      log('info', 'Conversation scenario replaced', { from: scenario.key, to: newStart.key });
      return true;
    }
    const ranked = (step.branches || [])
      .map((branch) => ({ branch, value: score(text, branch.examples) }))
      .sort((a, b) => b.value - a.value);
    const match = ranked[0]?.value >= 0.6 ? ranked[0].branch : null;
    if (!match) {
      if (step.fallbackStepId) {
        await run(
          organizationId,
          conversationId,
          scenario,
          step.fallbackStepId,
        );
        return true;
      }
      if (step.fallbackBody?.trim()) {
        await conversations.queueText(organizationId, conversationId, { body: step.fallbackBody });
        log("info", "Conversation scenario fallback replied", { scenario: scenario.key, step: step.id });
      } else {
        await conversations.queueText(organizationId, conversationId, { body: "Claro 😊, tómate tu tiempo para revisarlo. Cuando estés listo, responde a la pregunta anterior y con gusto continúo ayudándote." });
        log("info", "Conversation scenario default fallback replied", { scenario: scenario.key, step: step.id });
      }
      // A running scenario owns unmatched messages as well. Letting generic
      // catalog rules run here is what previously caused duplicate documents.
      return true;
    }
    await run(organizationId, conversationId, scenario, match.nextStepId);
    log("info", "Conversation scenario advanced", {
      scenario: scenario.key,
      step: step.id,
      branch: match.id,
    });
    return true;
  }
  const match = newStart;
  if (!match) return false;
  await run(organizationId, conversationId, match, match.steps[0].id);
  log("info", "Conversation scenario started", { scenario: match.key });
  return true;
};
