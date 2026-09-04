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
        ? phraseWords.filter((word) => textWords.includes(word)).length /
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
      'SELECT id,key,name,is_active AS "isActive",trigger_examples AS "triggerExamples",steps,updated_at AS "updatedAt" FROM automation_scenarios WHERE organization_id=$1 ORDER BY created_at',
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
        'INSERT INTO automation_scenarios (organization_id,key,name,is_active,trigger_examples,steps,config) VALUES ($1,$2,$3,$4,$5,$6,\'{}\') RETURNING id,key,name,is_active AS "isActive",trigger_examples AS "triggerExamples",steps,updated_at AS "updatedAt"',
        [
          organizationId,
          key,
          value.name,
          value.isActive,
          JSON.stringify(value.triggerExamples),
          JSON.stringify(value.steps),
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
    'UPDATE automation_scenarios SET name=$3,is_active=$4,trigger_examples=$5,steps=$6,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING id,key,name,is_active AS "isActive",trigger_examples AS "triggerExamples",steps,updated_at AS "updatedAt"',
    [
      id,
      organizationId,
      value.name,
      value.isActive,
      JSON.stringify(value.triggerExamples),
      JSON.stringify(value.steps),
    ],
  );
  if (!result.rows[0]) {
    const error = new Error("Scenario not found");
    error.status = 404;
    throw error;
  }
  return toRow(result.rows[0]);
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

const queueCatalog = async (organizationId, conversationId, caption) => {
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
  await conversations.queueDocument(organizationId, conversationId, {
    mediaId: document.media_id,
    filename: document.filename || undefined,
    caption: caption || undefined,
  });
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
  if (step.type === "send_catalog")
    await queueCatalog(organizationId, conversationId, step.caption);
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
  const [states, scenarios] = await Promise.all([
    db.query(
      "SELECT scenario_key,step FROM conversation_scenario_states WHERE organization_id=$1 AND conversation_id=$2 AND completed_at IS NULL",
      [organizationId, conversationId],
    ),
    exports.list(organizationId),
  ]);
  const active = scenarios.filter((scenario) => scenario.isActive);
  const state = states.rows[0];
  if (state) {
    const scenario = active.find((item) => item.key === state.scenario_key);
    const step = scenario && byId(scenario, state.step);
    if (!scenario || !step || step.type !== "wait_reply") return false;
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
      return false;
    }
    await run(organizationId, conversationId, scenario, match.nextStepId);
    log("info", "Conversation scenario advanced", {
      scenario: scenario.key,
      step: step.id,
      branch: match.id,
    });
    return true;
  }
  const ranked = active
    .map((scenario) => ({
      scenario,
      value: score(text, scenario.triggerExamples),
    }))
    .sort((a, b) => b.value - a.value);
  const match = ranked[0]?.value >= 0.6 ? ranked[0].scenario : null;
  if (!match) return false;
  await run(organizationId, conversationId, match, match.steps[0].id);
  log("info", "Conversation scenario started", { scenario: match.key });
  return true;
};
