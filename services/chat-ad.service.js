const { z } = require('zod');
const db = require('../lib/db');
const { normalize, score } = require('./text-match');

// chatAd: el primer mensaje del cliente decide qué botones de imágenes aparecen en su chat.
// Usa las mismas «Frases que lo inician» y el mismo umbral que los escenarios (sin IA).
const MATCH_THRESHOLD = 0.72;
const MAX_BUTTONS = 8;
const MAX_IMAGES = 10;
const fail = (status, message) => Object.assign(new Error(message), { status });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requireId = (id) => { if (!UUID.test(String(id))) throw fail(404, 'El chatAd ya no existe.'); };

const buttonSchema = z.object({
  label: z.string().trim().min(1, 'Ponle nombre a cada botón.').max(24, 'El nombre del botón puede tener hasta 24 caracteres.'),
  text: z.string().trim().max(1024, 'El texto del botón puede tener hasta 1024 caracteres.').optional().transform((value) => value || undefined),
  imageIds: z.array(z.string().uuid()).min(1, 'Elige al menos una imagen para cada botón.').max(MAX_IMAGES, `Cada botón puede llevar hasta ${MAX_IMAGES} imágenes.`)
    .transform((ids) => [...new Set(ids)]),
});
const adSchema = z.object({
  name: z.string().trim().min(1, 'Ponle nombre al chatAd.').max(80),
  isActive: z.boolean().default(true),
  triggerExamples: z.array(z.string().trim().min(2, 'Cada frase debe tener al menos 2 letras.').max(240)).min(1, 'Agrega al menos una frase que lo inicie.').max(30)
    .transform((items) => [...new Set(items)]),
  buttons: z.array(buttonSchema).min(1, 'Agrega al menos un botón.').max(MAX_BUTTONS, `Puedes tener hasta ${MAX_BUTTONS} botones.`),
}).strict();

const parse = (input) => {
  const result = adSchema.safeParse(input || {});
  if (!result.success) throw fail(400, result.error.issues[0].message);
  return result.data;
};

const COLUMNS = 'id, name, is_active AS "isActive", trigger_examples AS "triggerExamples", buttons, position, updated_at AS "updatedAt"';

exports.list = async (organizationId) =>
  (await db.query(`SELECT ${COLUMNS} FROM chat_ads WHERE organization_id=$1 ORDER BY position, created_at`, [organizationId])).rows;

const checkImages = async (organizationId, buttons) => {
  const ids = [...new Set(buttons.flatMap((button) => button.imageIds))];
  const found = await db.query(
    `SELECT image.id FROM entrepreneur_package_images image JOIN entrepreneur_packages p ON p.id=image.package_id
     WHERE p.organization_id=$1 AND image.id = ANY($2::uuid[])`,
    [organizationId, ids],
  );
  if (found.rows.length !== ids.length) throw fail(400, 'Una de las imágenes elegidas ya no existe. Vuelve a elegirlas.');
};

exports.create = async (organizationId, input) => {
  const ad = parse(input);
  await checkImages(organizationId, ad.buttons);
  return (await db.query(
    `INSERT INTO chat_ads (organization_id, name, is_active, trigger_examples, buttons, position)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,(SELECT COALESCE(MAX(position),-1)+1 FROM chat_ads WHERE organization_id=$1))
     RETURNING ${COLUMNS}`,
    [organizationId, ad.name, ad.isActive, JSON.stringify(ad.triggerExamples), JSON.stringify(ad.buttons)],
  )).rows[0];
};

exports.update = async (organizationId, id, input) => {
  requireId(id);
  const ad = parse(input);
  await checkImages(organizationId, ad.buttons);
  const row = (await db.query(
    `UPDATE chat_ads SET name=$3, is_active=$4, trigger_examples=$5::jsonb, buttons=$6::jsonb, updated_at=now()
     WHERE id=$1 AND organization_id=$2 RETURNING ${COLUMNS}`,
    [id, organizationId, ad.name, ad.isActive, JSON.stringify(ad.triggerExamples), JSON.stringify(ad.buttons)],
  )).rows[0];
  if (!row) throw fail(404, 'El chatAd ya no existe.');
  return row;
};

exports.remove = async (organizationId, id) => {
  requireId(id);
  const result = await db.query('DELETE FROM chat_ads WHERE id=$1 AND organization_id=$2', [id, organizationId]);
  if (!result.rowCount) throw fail(404, 'El chatAd ya no existe.');
};

// Largo (en palabras) de la frase que aparece completa en el mensaje; 99 si es idéntica. Desempata
// como en escenarios: gana la frase más específica, luego el que está más arriba.
const specificity = (text, examples) => Math.max(0, ...(examples || []).map((example) => {
  const phrase = normalize(example);
  if (!phrase) return 0;
  if (phrase === text) return 99;
  return ` ${text} `.includes(` ${phrase} `) ? phrase.split(' ').length : 0;
}));

/** chatAd activo que corresponde a un texto, o null. */
exports.match = (ads, message) => {
  const text = normalize(message);
  if (!text) return null;
  const ranked = ads.filter((ad) => ad.isActive)
    .map((ad) => ({ ad, value: score(text, ad.triggerExamples), specific: specificity(text, ad.triggerExamples) }))
    .sort((a, b) => b.value - a.value || b.specific - a.specific || a.ad.position - b.ad.position);
  return ranked[0]?.value >= MATCH_THRESHOLD ? ranked[0].ad : null;
};

const firstMessage = async (organizationId, conversationId) =>
  (await db.query(
    `SELECT body FROM messages
     WHERE organization_id=$1 AND conversation_id=$2 AND direction='inbound' AND deleted_at IS NULL AND NULLIF(btrim(body), '') IS NOT NULL
     ORDER BY created_at LIMIT 1`,
    [organizationId, conversationId],
  )).rows[0]?.body || null;

/** Botones del chat: se calculan con el primer mensaje, así cambiar un chatAd aplica a los chats existentes. */
exports.forConversation = async (organizationId, conversationId) => {
  if (!UUID.test(String(conversationId))) return { chatAd: null };
  const [message, ads] = await Promise.all([firstMessage(organizationId, conversationId), exports.list(organizationId)]);
  const ad = message ? exports.match(ads, message) : null;
  if (!ad) return { chatAd: null };
  // Las imágenes borradas después de configurar se omiten (y el botón, si se queda sin imágenes).
  const ids = [...new Set(ad.buttons.flatMap((button) => button.imageIds || []))];
  const existing = new Set(ids.length ? (await db.query(
    `SELECT image.id FROM entrepreneur_package_images image JOIN entrepreneur_packages p ON p.id=image.package_id
     WHERE p.organization_id=$1 AND image.id = ANY($2::uuid[])`,
    [organizationId, ids],
  )).rows.map((row) => row.id) : []);
  const buttons = ad.buttons
    .map((button) => ({ label: button.label, ...(button.text ? { text: button.text } : {}), imageIds: (button.imageIds || []).filter((id) => existing.has(id)) }))
    .filter((button) => button.imageIds.length);
  return buttons.length ? { chatAd: { id: ad.id, name: ad.name, buttons } } : { chatAd: null };
};

/** Prueba desde la sección chatAd: qué chatAd tomaría un primer mensaje. */
exports.test = async (organizationId, text) => {
  const ad = exports.match(await exports.list(organizationId), String(text || '').slice(0, 1000));
  return { chatAd: ad ? { id: ad.id, name: ad.name } : null };
};
