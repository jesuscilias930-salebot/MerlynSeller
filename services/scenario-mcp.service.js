const crypto = require('node:crypto');
const { z } = require('zod');
const db = require('../lib/db');
const scenarios = require('./scenario.service');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const projection = 'id,key,name,is_active AS "isActive",trigger_examples AS "triggerExamples",ai_description AS "aiDescription",priority,can_interrupt AS "canInterrupt",position,steps,updated_at AS "updatedAt"';
const revision = row => hash(JSON.stringify(row));

exports.issue = async auth => {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 7 * 86400000);
  await db.transaction(async client => {
    await client.query('DELETE FROM scenario_mcp_sessions WHERE organization_id=$1 AND user_id=$2', [auth.organizationId, auth.user.id]);
    await client.query('INSERT INTO scenario_mcp_sessions (token_hash,user_id,organization_id,expires_at) VALUES ($1,$2,$3,$4)', [hash(token), auth.user.id, auth.organizationId, expiresAt]);
  });
  return { token, expiresAt };
};
exports.revoke = auth => db.query('DELETE FROM scenario_mcp_sessions WHERE organization_id=$1 AND user_id=$2', [auth.organizationId, auth.user.id]);
exports.authenticate = async token => {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const result = await db.query(`SELECT s.organization_id AS "organizationId",s.user_id AS "userId"
    FROM scenario_mcp_sessions s JOIN memberships m ON m.organization_id=s.organization_id AND m.user_id=s.user_id
    WHERE s.token_hash=$1 AND s.expires_at>now() AND m.role IN ('owner','admin')`, [hash(token)]);
  return result.rows[0] || null;
};
exports.list = async organizationId => (await scenarios.list(organizationId)).map(row => ({ ...row, revision: revision(row) }));
exports.context = async (organizationId, client = db) => {
  const [columns, packages, documents, saved] = await Promise.all([
    client.query('SELECT id,name,position FROM lead_columns WHERE organization_id=$1 ORDER BY position', [organizationId]),
    client.query(`SELECT p.id,p.name,p.media_id AS "mediaId",p.filename,p.bundle_type AS "bundleType",
      COALESCE(json_agg(json_build_object('mediaId',i.media_id,'filename',i.filename,'caption',i.caption) ORDER BY i.position) FILTER (WHERE i.id IS NOT NULL),'[]') AS images
      FROM entrepreneur_packages p LEFT JOIN entrepreneur_package_images i ON i.package_id=p.id
      WHERE p.organization_id=$1 GROUP BY p.id ORDER BY p.position`, [organizationId]),
    client.query('SELECT id,filename,caption,media_id AS "mediaId",is_catalog AS "isCatalog" FROM document_templates WHERE organization_id=$1', [organizationId]),
    client.query('SELECT steps FROM automation_scenarios WHERE organization_id=$1', [organizationId]),
  ]);
  const scenarioMedia = [...new Map(saved.rows.flatMap(row => (row.steps || []).flatMap(step =>
    [...(step.items || []), ...(step.budgetOptions || []).flatMap(option => option.items || [])]
  )).map(item => [item.mediaId, item])).values()];
  return { columns: columns.rows, packages: packages.rows, documents: documents.rows, scenarioMedia };
};
exports.validate = async (organizationId, input, client = db) => {
  // Same parser as the visual editor; validation never runs the scenario.
  const definition = scenarios.parseDefinition({ ...input, isActive: input?.isActive ?? false, aiDescription: input?.aiDescription ?? null });
  const context = await exports.context(organizationId, client);
  const columns = new Set(context.columns.map(row => row.id));
  const packages = new Set(context.packages.map(row => row.id));
  const media = new Set([...context.scenarioMedia.map(row => row.mediaId), ...context.documents.map(row => row.mediaId), ...context.packages.flatMap(row => [row.mediaId, ...row.images.map(image => image.mediaId)])].filter(Boolean));
  const ids = new Map(definition.steps.map(step => [step.id, step]));
  const reachable = new Set(); const pending = [definition.steps[0].id];
  while (pending.length) {
    const id = pending.pop(); if (reachable.has(id)) continue; reachable.add(id);
    const step = ids.get(id);
    for (const next of [step.nextStepId, step.fallbackStepId, ...(step.branches || []).map(branch => branch.nextStepId)].filter(Boolean)) pending.push(next);
  }
  for (const step of definition.steps) {
    if (!reachable.has(step.id)) fail(400, `El paso ${step.label} no está conectado al inicio`);
    if (step.type === 'move_column' && !columns.has(step.columnId)) fail(400, 'Selecciona una columna existente de tu negocio');
    if (step.type === 'send_catalog' && !context.documents.some(row => row.isCatalog)) fail(400, 'Configura el catálogo del negocio antes de usar este paso');
    if (step.type === 'send_media' && !step.items?.length) fail(400, 'El paso de fotografías/documentos necesita archivos');
    for (const item of [...(step.items || []), ...(step.budgetOptions || []).flatMap(option => option.items || [])])
      if (!media.has(item.mediaId)) fail(400, 'El archivo no pertenece a los recursos disponibles de tu negocio');
    for (const option of step.budgetOptions || [])
      for (const id of option.packageIds || []) if (!packages.has(id)) fail(400, 'El paquete recomendado no pertenece a tu negocio');
    if (step.type !== 'end' && step.type !== 'wait_reply' && !step.nextStepId) fail(400, `Conecta el siguiente paso de ${step.label}`);
  }
  // Automatic-only cycles would send repeated messages. Loops that wait for a reply are allowed.
  const visiting = new Set(), done = new Set();
  const walk = id => {
    const step = ids.get(id); if (step.type === 'wait_reply' || step.type === 'budget_recommendation' || done.has(id)) return;
    if (visiting.has(id)) fail(400, 'Hay un ciclo de pasos automáticos sin esperar una respuesta');
    visiting.add(id); if (step.nextStepId) walk(step.nextStepId); visiting.delete(id); done.add(id);
  };
  for (const step of definition.steps) walk(step.id);
  return definition;
};
const editable = row => scenarios.parseDefinition(row);
exports.save = async (organizationId, input) => {
  const shape = z.object({ id: z.string().uuid(), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).nullable(), definition: z.unknown() }).safeParse(input);
  if (!shape.success) fail(400, 'Indica ID del escenario, revisión anterior (null para nuevo) y definición');
  const { id, expectedRevision } = shape.data;
  return db.transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`scenario-mcp:${organizationId}:${id}`]);
    const current = (await client.query(`SELECT ${projection} FROM automation_scenarios WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [id, organizationId])).rows[0];
    const definition = await exports.validate(organizationId, shape.data.definition, client);
    if (current && JSON.stringify(editable(current)) === JSON.stringify(definition)) return { ...current, revision: revision(current) };
    if (current && (!expectedRevision || revision(current) !== expectedRevision)) fail(409, 'El escenario cambió. Consulta su versión actual antes de guardarlo');
    if (!current && expectedRevision) fail(404, 'Escenario no encontrado en tu negocio');
    const values = [id, organizationId, definition.name, definition.isActive, JSON.stringify(definition.triggerExamples), definition.aiDescription || null, definition.priority, definition.canInterrupt, JSON.stringify(definition.steps)];
    const sql = current
      ? `UPDATE automation_scenarios SET name=$3,is_active=$4,trigger_examples=$5,ai_description=$6,priority=$7,can_interrupt=$8,steps=$9,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING ${projection}`
      : `INSERT INTO automation_scenarios (id,organization_id,name,is_active,trigger_examples,ai_description,priority,can_interrupt,steps,key,position,config) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'mcp_'||$1::text,COALESCE((SELECT MAX(position)+1 FROM automation_scenarios WHERE organization_id=$2),0),'{}') RETURNING ${projection}`;
    const row = (await client.query(sql, values)).rows[0];
    return { ...row, revision: revision(row) };
  });
};
exports.revision = revision;
