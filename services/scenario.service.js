const { z } = require("zod");
const db = require("../lib/db");
const conversations = require("./conversation.service");
const messageService = require("./message.service");
const interactiveOptions = require("./interactive-options");

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
const levenshtein = (left, right) => {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const current = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        previous + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      previous = current;
    }
  }
  return row[right.length];
};
const similar = (left, right) =>
  left === right ||
  (left.length >= 3 &&
    right.length >= 3 &&
    levenshtein(left, right) <=
      Math.max(1, Math.floor(Math.max(left.length, right.length) * 0.25)));
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
        ? phraseWords.filter((word) =>
            textWords.some((candidate) => similar(word, candidate)),
          ).length / phraseWords.length
        : 0;
    }),
  );
const log = (level, message, fields = {}) =>
  console.log(JSON.stringify({ level, message, ...fields }));

const branchSchema = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(100),
  aiDescription: z.string().trim().max(700).optional(),
  examples: z.array(z.string().trim().min(1).max(240)).min(1).max(30),
  nextStepId: z.string().trim().min(1).max(80),
});
const budgetOptionSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(120),
    min: z.number().min(0).optional(),
    max: z.number().min(0).optional(),
    examples: z.array(z.string().trim().min(1).max(240)).max(20).optional(),
    packageIds: z.array(z.string().uuid()).max(20).optional(),
    items: z.array(z.object({
      mediaId: z.string().trim().min(1).max(256),
      filename: z.string().max(240).optional(),
      caption: z.string().max(1024).optional(),
      type: z.literal("image").optional(),
    })).max(50).optional(),
    recommendationBody: z.string().trim().min(1).max(4096),
  })
  .refine(
    (option) => option.min == null || option.max == null || option.min <= option.max,
    "El presupuesto mínimo no puede ser mayor que el máximo",
  )
  .refine(
    (option) => Boolean(option.packageIds?.length || option.items?.length),
    "Selecciona al menos un paquete o fotografía para la recomendación",
  );
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
    "send_options",
    "budget_recommendation",
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
  budgetOptions: z.array(budgetOptionSchema).min(1).max(50).optional(),
  fallbackStepId: z.string().trim().min(1).max(80).optional(),
  nextStepId: z.string().trim().min(1).max(80).optional(),
  columnId: z.string().uuid().optional().or(z.literal("")),
  // send_options: mensaje con botones/lista; cada opción puede continuar en un paso.
  header: z.string().max(60).optional(),
  footer: z.string().max(60).optional(),
  format: z.enum(["auto", "buttons", "list"]).optional(),
  buttonText: z.string().max(20).optional(),
  sectionTitle: z.string().max(24).optional(),
  options: z
    .array(
      z.object({
        id: z.string().trim().max(200).optional(),
        title: z.string().max(24),
        description: z.string().max(72).optional(),
        nextStepId: z.string().trim().min(1).max(80).optional(),
      }),
    )
    .max(10)
    .optional(),
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
          message: `El identificador de paso ${step.id} está repetido`,
        });
      ids.add(step.id);
      if (step.type === "send_text" && !step.body?.trim())
        ctx.addIssue({
          code: "custom",
          message: `Paso ${index + 1} (${step.label}): escribe el mensaje`,
        });
      if (step.type === "wait_reply" && !step.branches?.length)
        ctx.addIssue({
          code: "custom",
          message: `Paso ${index + 1} (${step.label}): agrega al menos una respuesta posible`,
        });
      if (step.type === "send_options" && !step.options?.length)
        ctx.addIssue({
          code: "custom",
          message: `Paso ${index + 1} (${step.label}): agrega al menos una opción`,
        });
      if (step.type === "budget_recommendation" && !step.budgetOptions?.length)
        ctx.addIssue({
          code: "custom",
          message: `Paso ${index + 1} (${step.label}): agrega al menos un rango de presupuesto`,
        });
      if (step.type === "budget_recommendation" && !step.nextStepId)
        ctx.addIssue({
          code: "custom",
          message: `Paso ${index + 1} (${step.label}): elige el paso que continúa después de recomendar`,
        });
    }
    const references = value.steps
      .flatMap((step) => [
        step.nextStepId,
        step.fallbackStepId,
        ...(step.branches || []).map((branch) => branch.nextStepId),
        ...(step.options || []).map((option) => option.nextStepId),
      ])
      .filter(Boolean);
    for (const id of references)
      if (!ids.has(id))
        ctx.addIssue({
          code: "custom",
          message: `Una conexión apunta a un paso que ya no existe (${id})`,
        });
  });
const optionMessage = (step) => ({
  format: step.format || "auto",
  header: step.header,
  body: step.body,
  footer: step.footer,
  buttonText: step.buttonText,
  sectionTitle: step.sectionTitle,
  options: (step.options || []).map(({ id, title, description }) => ({ id, title, description })),
});
// Valida el mensaje con los mismos límites de WhatsApp que el chat y fija ids
// estables por opción para reconocer la respuesta del cliente.
const normalizeOptionsStep = (step, index) => {
  let message;
  try {
    message = interactiveOptions.normalize(optionMessage(step));
  } catch (cause) {
    const error = new Error(`Paso ${index + 1} (${step.label}): ${cause.message}`);
    error.status = 400;
    throw error;
  }
  const normalized = {
    ...step,
    format: step.format || "auto",
    body: message.body,
    options: message.options.map((option, position) => ({
      ...option,
      ...(step.options[position].nextStepId ? { nextStepId: step.options[position].nextStepId } : {}),
    })),
  };
  for (const key of ["header", "footer", "buttonText", "sectionTitle"]) {
    const value = step[key]?.trim();
    if (value) normalized[key] = value;
    else delete normalized[key];
  }
  return normalized;
};
// Traduce el primer problema de validación a un mensaje claro en español,
// indicando el paso y el campo para que se pueda corregir sin perder el trabajo.
const fieldNames = {
  name: "Nombre", triggerExamples: "Frases que lo inician", aiDescription: "Descripción para la IA", steps: "Pasos",
  label: "Nombre del paso", body: "Mensaje", caption: "Texto que acompaña", fallbackBody: "Respuesta si no coincide",
  branches: "Respuestas posibles", examples: "Ejemplos", nextStepId: "Siguiente paso", columnId: "Columna",
  budgetOptions: "Rangos de presupuesto", recommendationBody: "Texto de recomendación", items: "Archivos",
  options: "Opciones", title: "Texto de la opción", description: "Descripción", header: "Encabezado", footer: "Pie",
  buttonText: "Texto del botón", sectionTitle: "Título de la sección", id: "Identificador",
};
const describeIssue = (issue, input) => {
  const path = issue.path || [];
  const parts = [];
  if (path[0] === "steps" && Number.isInteger(path[1])) {
    const label = input?.steps?.[path[1]]?.label;
    parts.push(`Paso ${path[1] + 1}${label ? ` (${label})` : ""}`);
  }
  const field = [...path].reverse().find((key) => typeof key === "string" && key !== "steps");
  if (field && fieldNames[field]) parts.push(fieldNames[field]);
  const origin = issue.origin === "array" ? "array" : "string";
  let message = issue.message;
  if (issue.code === "too_small") message = origin === "array" ? (issue.minimum <= 1 ? "agrega al menos uno" : `agrega al menos ${issue.minimum}`) : issue.minimum <= 1 ? "no puede quedar vacío" : `necesita al menos ${issue.minimum} caracteres`;
  else if (issue.code === "too_big") message = origin === "array" ? `admite máximo ${issue.maximum}` : `admite máximo ${issue.maximum} caracteres`;
  else if (issue.code === "invalid_type") message = "falta o tiene un formato inválido";
  else if (issue.code === "invalid_value") message = "tiene un valor no permitido";
  else if (issue.code === "invalid_format") message = "tiene un formato inválido";
  if (issue.code === "custom") return message;
  return parts.length ? `${parts.join(" · ")}: ${message}` : message;
};
const parse = (input) => {
  const result = scenarioSchema.safeParse(input);
  if (result.success)
    return {
      ...result.data,
      steps: result.data.steps.map((step, index) =>
        step.type === "send_options" ? normalizeOptionsStep(step, index) : step,
      ),
    };
  const error = new Error(describeIssue(result.error.issues[0], input));
  error.status = 400;
  throw error;
};
exports.parseDefinition = parse;
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
          value.aiDescription || null,
          value.priority,
          value.canInterrupt,
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
    'UPDATE automation_scenarios SET name=$3,is_active=$4,trigger_examples=$5,ai_description=$6,priority=$7,can_interrupt=$8,steps=$9,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING id,key,name,is_active AS "isActive",trigger_examples AS "triggerExamples",ai_description AS "aiDescription",priority,can_interrupt AS "canInterrupt",position,steps,updated_at AS "updatedAt"',
    [
      id,
      organizationId,
      value.name,
      value.isActive,
      JSON.stringify(value.triggerExamples),
      value.aiDescription || null,
      value.priority,
      value.canInterrupt,
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
exports.reorder = async (organizationId, input) => {
  const ids = z
    .array(z.string().uuid())
    .min(1)
    .max(100)
    .safeParse(input?.scenarioIds);
  if (!ids.success) {
    const error = new Error("scenarioIds must include every scenario");
    error.status = 400;
    throw error;
  }
  await db.transaction(async (client) => {
    const existing = await client.query(
      "SELECT id FROM automation_scenarios WHERE organization_id=$1 FOR UPDATE",
      [organizationId],
    );
    const expected = new Set(existing.rows.map((row) => row.id));
    const received = new Set(ids.data);
    if (
      expected.size !== received.size ||
      [...expected].some((id) => !received.has(id))
    ) {
      const error = new Error(
        "The scenario order must include every scenario exactly once",
      );
      error.status = 400;
      throw error;
    }
    await client.query(
      `UPDATE automation_scenarios AS scenario SET position=ordered.position - 1 FROM unnest($2::uuid[]) WITH ORDINALITY AS ordered(id,position) WHERE scenario.organization_id=$1 AND scenario.id=ordered.id`,
      [organizationId, ids.data],
    );
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

const hasSentCatalog = async (organizationId, conversationId) =>
  Boolean(
    (
      await db.query(
        `
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
`,
        [organizationId, conversationId],
      )
    ).rows[0]?.sent,
  );
const queueCatalog = async (
  organizationId,
  conversationId,
  caption,
  force = false,
) => {
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
  if (!force && (await hasSentCatalog(organizationId, conversationId)))
    return false;
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
  if (
    !process.env.OPENAI_API_KEY ||
    !process.env.OPENAI_AUTOMATION_MODEL ||
    !scenarios.length
  )
    return null;
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_AUTOMATION_MODEL,
        store: false,
        instructions:
          "Classify the Spanish customer message into at most one scenario. Handle common typos. Return no key if ambiguous. Select only when the scenario clearly matches the meaning.",
        input: JSON.stringify({
          message: text,
          scenarios: scenarios.map((scenario) => ({
            key: scenario.key,
            name: scenario.name,
            description: scenario.aiDescription || "",
            examples: scenario.triggerExamples,
          })),
        }),
        text: {
          format: {
            type: "json_schema",
            name: "scenario_match",
            strict: true,
            schema: {
              type: "object",
              properties: {
                key: { type: ["string", "null"] },
                confidence: { type: "number" },
              },
              required: ["key", "confidence"],
              additionalProperties: false,
            },
          },
        },
      }),
      signal: AbortSignal.timeout(8000),
    });
    const body = await response.json();
    if (!response.ok || body.error) return null;
    const parsed = JSON.parse(body.output_text || "{}");
    return parsed.confidence >= 0.82
      ? scenarios.find((scenario) => scenario.key === parsed.key) || null
      : null;
  } catch (error) {
    log("warn", "Scenario AI classification failed", { errorType: error.name });
    return null;
  }
};

const localClarificationSignal = (text) => {
  const normalized = normalize(text);
  return ["checo", "reviso", "revisando", "viendo", "leo", "leyendo", "momento", "ahorita", "mas tarde", "despues"].some((phrase) => normalized.includes(phrase));
};
const classifyUnmatchedReply = async (text, scenario, step) => {
  const branches = step.branches || [];
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_AUTOMATION_MODEL) {
    return localClarificationSignal(text) ? { decision: "clarify", confidence: 0.9 } : { decision: "requires_human", confidence: 0 };
  }
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_AUTOMATION_MODEL,
        store: false,
        instructions: "You are a cautious Spanish WhatsApp sales-flow router. Decide only one action for the customer reply in the active scenario. Use continue_branch only when the reply clearly belongs to one listed branch. Use clarify when the customer is merely reviewing, asking for time, or needs a brief contextual clarification. Use requires_human for a specific quote, quantity/product request not covered by a branch, unrelated request, ambiguity, or low confidence. Never invent an answer, never choose a branch by keyword alone, and do not send a catalog.",
        input: JSON.stringify({ customerMessage: text, activeScenario: { name: scenario.name, description: scenario.aiDescription || "" }, waitingStep: { label: step.label, fallbackMessage: step.fallbackBody || "" }, branches: branches.map((branch) => ({ id: branch.id, name: branch.name, description: branch.aiDescription || "", examples: branch.examples })) }),
        text: { format: { type: "json_schema", name: "scenario_reply_decision", strict: true, schema: { type: "object", properties: { decision: { type: "string", enum: ["continue_branch", "clarify", "requires_human"] }, branchId: { type: ["string", "null"] }, confidence: { type: "number" } }, required: ["decision", "branchId", "confidence"], additionalProperties: false } } },
      }),
      signal: AbortSignal.timeout(8000),
    });
    const body = await response.json();
    if (!response.ok || body.error) return { decision: "requires_human", confidence: 0 };
    const parsed = JSON.parse(body.output_text || "{}");
    if (!["continue_branch", "clarify", "requires_human"].includes(parsed.decision)) return { decision: "requires_human", confidence: 0 };
    return parsed;
  } catch (error) {
    log("warn", "Scenario reply AI classification failed", { errorType: error.name });
    return localClarificationSignal(text) ? { decision: "clarify", confidence: 0.9 } : { decision: "requires_human", confidence: 0 };
  }
};
const sendClarification = async (organizationId, conversationId, step) => conversations.queueText(organizationId, conversationId, {
  body: step.fallbackBody.trim(),
});

const amountFromText = (text) => {
  const match = String(text || "").match(/\d[\d.,]*/);
  if (!match) return null;
  const compact = match[0].replace(/[.,]/g, "");
  const amount = Number(compact);
  return Number.isFinite(amount) ? amount : null;
};
const budgetOptionForReply = (text, options) => {
  const normalized = normalize(text);
  const scored = options
    .map((option) => ({
      option,
      value: score(normalized, [option.label, ...(option.examples || [])]),
    }))
    .sort((left, right) => right.value - left.value);
  if (scored[0]?.value >= 0.65) return scored[0].option;
  const amount = amountFromText(text);
  if (amount == null) return null;
  return (
    options.find(
      (option) =>
        (option.min == null || amount >= option.min) &&
        (option.max == null || amount <= option.max),
    ) || null
  );
};
const interpolateRecommendation = (body, option, packages) => {
  const names = packages.map((item) => item.name).join(", ");
  return body
    .replaceAll("{{package_name}}", packages[0]?.name || "paquete emprendedor")
    .replaceAll("{{package_names}}", names || "paquetes emprendedores")
    .replaceAll("{{budget}}", option.label);
};
const sendBudgetRecommendation = async (
  organizationId,
  conversationId,
  option,
) => {
  const packageIds = option.packageIds || [];
  const rows = (
    await db.query(
      `SELECT package.id,package.name,COUNT(image.id)::integer AS "imageCount"
       FROM entrepreneur_packages package
       LEFT JOIN entrepreneur_package_images image ON image.package_id=package.id
       WHERE package.organization_id=$1 AND package.id = ANY($2::uuid[])
       GROUP BY package.id,package.name`,
      [organizationId, packageIds],
    )
  ).rows;
  const byId = new Map(rows.map((item) => [item.id, item]));
  if (byId.size !== packageIds.length) {
    const error = new Error("A package configured in this budget option no longer exists");
    error.status = 400;
    throw error;
  }
  const packages = packageIds.map((id) => byId.get(id));
  if (packages.some((item) => !item.imageCount)) {
    const error = new Error("Every package in a budget recommendation needs at least one photo");
    error.status = 400;
    throw error;
  }
  await conversations.queueText(organizationId, conversationId, {
    body: interpolateRecommendation(option.recommendationBody, option, packages),
  });
  if (packageIds.length)
    await conversations.queueEntrepreneurPackages(organizationId, conversationId, {
      packageIds,
    });
  for (const item of option.items || [])
    await conversations.queueExistingMedia(
      organizationId,
      conversationId,
      "image",
      item.mediaId,
      item.caption,
    );
};

// Una opción sin destino termina el escenario (el equipo continúa la conversación).
const advance = (organizationId, conversationId, scenario, nextStepId) =>
  nextStepId
    ? run(organizationId, conversationId, scenario, nextStepId)
    : complete(organizationId, conversationId);
const optionBranches = (step) =>
  (step.options || []).map((option) => ({
    id: option.id,
    name: option.title,
    aiDescription: option.description,
    examples: [option.title],
    nextStepId: option.nextStepId,
  }));
// Reconoce la opción elegida: id exacto del botón/lista, texto idéntico o,
// si la escribió, la opción más parecida sin empate.
const optionForReply = (step, text, optionId) => {
  const options = step.options || [];
  if (optionId) {
    const exact = options.find((option) => option.id === optionId);
    if (exact) return exact;
  }
  const normalized = normalize(text);
  if (!normalized) return null;
  const same = options.find((option) => normalize(option.title) === normalized);
  if (same) return same;
  const ranked = options
    .map((option) => ({ option, value: score(normalized, [option.title]) }))
    .sort((left, right) => right.value - left.value);
  return ranked[0]?.value >= 0.6 && ranked[0].value > (ranked[1]?.value || 0)
    ? ranked[0].option
    : null;
};
exports.optionForReply = optionForReply;

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
  if (step.type === "wait_reply" || step.type === "budget_recommendation") {
    await setCurrentStep(organizationId, conversationId, scenario.key, step.id);
    return;
  }
  if (step.type === "send_options") {
    await conversations.queueOptions(organizationId, conversationId, optionMessage(step));
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
    const sent = await queueCatalog(
      organizationId,
      conversationId,
      step.caption,
      step.resendCatalog === true,
    );
    if (!sent)
      await conversations.queueText(organizationId, conversationId, {
        body: "El catálogo ya está en esta conversación. Si no puedes abrirlo, dime y con gusto te lo reenvío.",
      });
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
  if (!text) return { handled: false, requiresHuman: false };
  const [states, scenarios, conversation] = await Promise.all([
    db.query("SELECT scenario_key,step FROM conversation_scenario_states WHERE organization_id=$1 AND conversation_id=$2 AND completed_at IS NULL", [organizationId, conversationId]),
    exports.list(organizationId),
    db.query("SELECT scenario_enabled FROM conversations WHERE id=$1 AND organization_id=$2", [conversationId, organizationId]),
  ]);
  if (conversation.rows[0]?.scenario_enabled === false) return { handled: false, requiresHuman: false };
  const active = scenarios.filter((scenario) => scenario.isActive);
  const state = states.rows[0];
  const rankedStarts = active.map((scenario) => ({ scenario, value: score(text, scenario.triggerExamples) })).sort((a, b) => b.value - a.value || a.scenario.position - b.scenario.position || b.scenario.priority - a.scenario.priority);
  let newStart = rankedStarts[0]?.value >= 0.72 ? rankedStarts[0].scenario : null;
  if (!newStart) newStart = await aiMatchScenario(text, active);

  if (state) {
    const scenario = active.find((item) => item.key === state.scenario_key);
    const step = scenario && byId(scenario, state.step);
    if (!scenario || !step || !["wait_reply", "budget_recommendation", "send_options"].includes(step.type)) return { handled: false, requiresHuman: false };
    if (step.type === "send_options") {
      const option = optionForReply(step, incoming);
      if (option) {
        await advance(organizationId, conversationId, scenario, option.nextStepId);
        log("info", "Conversation scenario option selected", { scenario: scenario.key, step: step.id, option: option.id, source: "text" });
        return { handled: true, requiresHuman: false };
      }
    }
    if (newStart && newStart.key !== scenario.key && newStart.canInterrupt) {
      await complete(organizationId, conversationId);
      await run(organizationId, conversationId, newStart, newStart.steps[0].id);
      log("info", "Conversation scenario replaced", { from: scenario.key, to: newStart.key });
      return { handled: true, requiresHuman: false };
    }

    if (step.type === "budget_recommendation") {
      const option = budgetOptionForReply(incoming, step.budgetOptions || []);
      if (!option) {
        if (step.fallbackBody?.trim()) {
          await sendClarification(organizationId, conversationId, step);
          return { handled: true, requiresHuman: false };
        }
        return { handled: false, requiresHuman: true };
      }
      await sendBudgetRecommendation(organizationId, conversationId, option);
      await run(organizationId, conversationId, scenario, step.nextStepId);
      log("info", "Conversation scenario budget recommendation sent", {
        scenario: scenario.key,
        step: step.id,
        option: option.id,
      });
      return { handled: true, requiresHuman: false };
    }

    const branches = step.type === "send_options" ? optionBranches(step) : step.branches || [];
    const ranked = step.type === "send_options" ? [] : branches.map((branch) => ({ branch, value: score(text, branch.examples) })).sort((a, b) => b.value - a.value);
    const match = ranked[0]?.value >= 0.6 ? ranked[0].branch : null;
    if (match) {
      await run(organizationId, conversationId, scenario, match.nextStepId);
      log("info", "Conversation scenario advanced", { scenario: scenario.key, step: step.id, branch: match.id });
      return { handled: true, requiresHuman: false };
    }
    const decision = await classifyUnmatchedReply(text, scenario, { ...step, branches });
    const aiBranch = branches.find((branch) => branch.id === decision.branchId);
    if (decision.decision === "continue_branch" && decision.confidence >= 0.82 && aiBranch) {
      await advance(organizationId, conversationId, scenario, aiBranch.nextStepId);
      log("info", "Conversation scenario AI branch selected", { scenario: scenario.key, step: step.id, branch: aiBranch.id, confidence: decision.confidence });
      return { handled: true, requiresHuman: false };
    }
    if (decision.decision === "clarify" && decision.confidence >= 0.7) {
      if (step.fallbackStepId) {
        await run(organizationId, conversationId, scenario, step.fallbackStepId);
        log("info", "Conversation scenario clarification advanced through configured fallback", { scenario: scenario.key, step: step.id, confidence: decision.confidence });
        return { handled: true, requiresHuman: false };
      }
      if (step.fallbackBody?.trim()) {
        await sendClarification(organizationId, conversationId, step);
        log("info", "Conversation scenario clarification sent", { scenario: scenario.key, step: step.id, confidence: decision.confidence });
        return { handled: true, requiresHuman: false };
      }
      log("info", "Scenario clarification escalated to human attention: no configured fallback", { scenario: scenario.key, step: step.id, confidence: decision.confidence });
      return { handled: false, requiresHuman: true };
    }
    log("info", "Conversation scenario requires human attention", { scenario: scenario.key, step: step.id, confidence: decision.confidence || 0 });
    return { handled: false, requiresHuman: true };
  }

  if (!newStart) return { handled: false, requiresHuman: false };
  await run(organizationId, conversationId, newStart, newStart.steps[0].id);
  log("info", "Conversation scenario started", { scenario: newStart.key });
  return { handled: true, requiresHuman: false };
};

// Respuesta a un paso "send_options" activo. Se evalúa antes que las reglas
// generales (p. ej. cotizaciones con cantidad de pares) para que tocar
// «Caricatura 500 pares» continúe el escenario en vez de escalar.
exports.processOptionReply = async (organizationId, conversationId, incoming, optionId) => {
  const [states, conversation] = await Promise.all([
    db.query("SELECT scenario_key,step FROM conversation_scenario_states WHERE organization_id=$1 AND conversation_id=$2 AND completed_at IS NULL", [organizationId, conversationId]),
    db.query("SELECT scenario_enabled FROM conversations WHERE id=$1 AND organization_id=$2", [conversationId, organizationId]),
  ]);
  const state = states.rows[0];
  if (!state || conversation.rows[0]?.scenario_enabled === false) return { handled: false };
  const scenario = (await exports.list(organizationId)).find((item) => item.isActive && item.key === state.scenario_key);
  const step = scenario && byId(scenario, state.step);
  if (!step || step.type !== "send_options") return { handled: false };
  const option = optionForReply(step, incoming, optionId);
  if (!option) return { handled: false };
  await advance(organizationId, conversationId, scenario, option.nextStepId);
  log("info", "Conversation scenario option selected", { scenario: scenario.key, step: step.id, option: option.id, source: optionId ? "interactive" : "text" });
  return { handled: true };
};
