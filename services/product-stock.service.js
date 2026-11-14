// Imágenes de un producto con sus tallas disponibles («Tallas disponibles: S, M, G»), para chats y escenarios.
// Las existencias y fotos vienen de SockControl (servidor a servidor); color y modelo, del CRM.
const db = require('../lib/db');
const productDetails = require('./product-detail.service');

const fail = (status, message) => Object.assign(new Error(message), { status });
const CACHE_MS = 45_000;
const MEDIA_REUSE_DAYS = 25; // Los archivos subidos a WhatsApp duran 30 días.
let cache = null;

const norm = (value) => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const controlUrl = () => {
  const url = new URL(process.env.SOCK_CONTROL_URL || 'http://localhost:8080');
  if (url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw fail(503, 'SOCK_CONTROL_URL inválida');
  return url;
};

/** Productos de la tienda con existencia y fotos. Caché corta: varios envíos seguidos no repiten la consulta. */
exports.fetchStock = async ({ force = false, fetcher = fetch, now = Date.now() } = {}) => {
  if (!force && cache && now - cache.at < CACHE_MS) return cache.items;
  const secret = process.env.STORE_SHIPPING_SECRET || '';
  if (secret.length < 32) throw fail(503, 'Configura STORE_SHIPPING_SECRET para consultar existencias');
  let response;
  try {
    response = await fetcher(new URL('/internal/crm/product-stock', controlUrl()), { headers: { 'X-Store-Shipping-Secret': secret }, signal: AbortSignal.timeout(10000) });
  } catch { throw fail(503, 'No se pudo consultar el inventario en SockControl'); }
  if (!response.ok) throw fail(503, `SockControl no entregó el inventario (${response.status})`);
  const items = await response.json();
  if (!Array.isArray(items)) throw fail(503, 'Respuesta de inventario inválida');
  cache = { at: now, items };
  return items;
};
exports.clearCache = () => { cache = null; };

/** Solo la organización de la tienda comparte inventario con SockControl. */
const requireStoreOrganization = (organizationId) => {
  const store = process.env.STORE_ORGANIZATION_ID;
  if (store && store !== organizationId) throw fail(403, 'El inventario de la tienda solo está disponible para su organización');
};

const LETTER_SIZES = ['xxch', 'xch', 'xs', 'ch', 's', 'm', 'g', 'l', 'eg', 'xl', 'xxl', '2xl', 'xxxl', '3xl', '4xl'];
/** Tallas en orden natural: CH, M, G… y luego numéricas por su primer número (2-4, 5-7, 22-24). */
exports.compareSizes = (a, b) => {
  const la = LETTER_SIZES.indexOf(norm(a).replace(/ /g, '')), lb = LETTER_SIZES.indexOf(norm(b).replace(/ /g, ''));
  if (la !== -1 || lb !== -1) return (la === -1 ? 999 : la) - (lb === -1 ? 999 : lb) || String(a).localeCompare(String(b), 'es');
  const na = Number((String(a).match(/\d+/) || [])[0] ?? Number.MAX_SAFE_INTEGER), nb = Number((String(b).match(/\d+/) || [])[0] ?? Number.MAX_SAFE_INTEGER);
  return na - nb || String(a).localeCompare(String(b), 'es', { numeric: true });
};

/** Productos de Control con color y modelo del CRM. */
const withDetails = (items, details) => {
  const extra = new Map(details.map((row) => [Number(row.productId), row]));
  return items.map((item) => ({ ...item, color: extra.get(Number(item.id))?.color || null, model: extra.get(Number(item.id))?.model || null }));
};
// Mismo modelo (o nombre), color y género: son las tallas de una misma foto.
const familyKey = (item) => `${norm(item.model || item.name)}|${norm(item.color)}|${norm(item.gender)}`;
exports.familyKey = familyKey;

/** Las tallas con existencia de la familia del producto, ordenadas. «» = talla única. */
exports.availableSizes = (family) => [...new Set(family.filter((item) => Number(item.stock) > 0).map((item) => String(item.size || '').trim()))].sort(exports.compareSizes);
exports.sizesText = (sizes) => {
  if (!sizes.length) return null;
  const named = sizes.filter(Boolean);
  return named.length ? `Tallas disponibles: ${named.join(', ')}` : 'Disponible';
};
const title = (item) => [item.model || item.name, item.color, item.gender].filter(Boolean).join(' · ');

/** Familias (una por foto posible) con sus tallas disponibles y fotos del E-commerce, para elegir en chats y escenarios. */
exports.families = (items) => {
  const groups = new Map();
  for (const item of items) {
    const key = familyKey(item);
    const group = groups.get(key) || { key, productId: item.id, title: title(item), category: item.category || null, members: [], photos: [] };
    groups.set(key, group);
    group.members.push(item);
    for (const photo of item.photos || []) if (!group.photos.some((p) => p.id === photo.id)) group.photos.push(photo);
  }
  return [...groups.values()].map((group) => {
    const sizes = exports.availableSizes(group.members);
    // El producto ancla es el de menor id: estable aunque cambien las existencias.
    const anchor = group.members.reduce((min, item) => (Number(item.id) < Number(min.id) ? item : min));
    return {
      productId: Number(anchor.id), title: group.title, category: group.category,
      sizes, caption: exports.sizesText(sizes), stock: group.members.reduce((sum, item) => sum + Math.max(0, Number(item.stock) || 0), 0),
      photos: group.photos.slice(0, 6), productIds: group.members.map((item) => Number(item.id)),
    };
  }).sort((a, b) => a.title.localeCompare(b.title, 'es'));
};

exports.catalog = async (organizationId) => {
  requireStoreOrganization(organizationId);
  const [items, details] = await Promise.all([exports.fetchStock(), productDetails.list(organizationId)]);
  return exports.families(withDetails(items, details));
};

/** Sube una foto del E-commerce a WhatsApp una sola vez y reutiliza su id mientras siga vigente. */
const photoMediaId = async (organizationId, photo, { fetcher = fetch } = {}) => {
  const cached = await db.query(
    `SELECT media_id FROM product_photo_media WHERE organization_id=$1 AND photo_id=$2 AND uploaded_at > now() - ($3 || ' days')::interval`,
    [organizationId, photo.id, String(MEDIA_REUSE_DAYS)],
  );
  if (cached.rows[0]) return cached.rows[0].media_id;
  let response;
  try { response = await fetcher(photo.url, { signal: AbortSignal.timeout(20000) }); } catch { throw fail(502, 'No se pudo descargar la foto del producto'); }
  if (!response.ok) throw fail(502, 'La foto del producto ya no está disponible');
  const contentType = (response.headers.get('content-type') || 'image/png').split(';')[0];
  const buffer = Buffer.from(await response.arrayBuffer());
  const { mediaId } = await require('./message.service').uploadMedia({ buffer, contentType: ['image/jpeg', 'image/png'].includes(contentType) ? contentType : 'image/png', filename: `producto-${photo.id}.${contentType === 'image/jpeg' ? 'jpg' : 'png'}` });
  await db.query(
    `INSERT INTO product_photo_media (organization_id, photo_id, media_id) VALUES ($1,$2,$3)
     ON CONFLICT (organization_id, photo_id) DO UPDATE SET media_id=EXCLUDED.media_id, uploaded_at=now()`,
    [organizationId, photo.id, mediaId],
  );
  return mediaId;
};

/**
 * Resuelve una imagen de producto: { productId, mediaId? (imagen propia), caption? (texto extra) }.
 * Devuelve { mediaId, caption } o { skip } cuando no hay tallas disponibles o no hay imagen.
 */
exports.resolve = async (organizationId, item, deps = {}) => {
  requireStoreOrganization(organizationId);
  const [items, details] = await Promise.all([exports.fetchStock(deps), productDetails.list(organizationId)]);
  const all = withDetails(items, details);
  const anchor = all.find((product) => Number(product.id) === Number(item.productId));
  if (!anchor) return { skip: 'El producto ya no existe en Control de ventas' };
  const family = all.filter((product) => familyKey(product) === familyKey(anchor));
  const sizes = exports.availableSizes(family);
  const name = title(anchor);
  if (!sizes.length) return { skip: `${name}: agotado`, title: name };
  const photo = (anchor.photos || [])[0] || family.flatMap((product) => product.photos || [])[0];
  if (!item.mediaId && !photo) return { skip: `${name}: sin foto en el E-commerce`, title: name };
  const mediaId = item.mediaId || await photoMediaId(organizationId, photo, deps);
  const caption = [item.caption?.trim(), exports.sizesText(sizes)].filter(Boolean).join('\n');
  return { mediaId, caption, title: name, sizes };
};

/** Encola las imágenes en orden; las agotadas o sin foto se omiten y se reportan. */
exports.queue = async (organizationId, conversationId, products, deps = {}) => {
  const conversations = require('./conversation.service');
  const queued = [], skipped = [];
  for (const item of products) {
    const result = await exports.resolve(organizationId, item, deps);
    if (result.skip) { skipped.push(result.skip); continue; }
    queued.push(await conversations.queueExistingMedia(organizationId, conversationId, 'image', result.mediaId, result.caption));
  }
  if (skipped.length) console.log(JSON.stringify({ level: 'info', message: 'Product stock images skipped', count: skipped.length }));
  return { queued: queued.length, skipped };
};
