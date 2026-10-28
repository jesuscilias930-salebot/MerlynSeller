const db = require('../lib/db');

// Messenger e Instagram Direct (Messenger Platform). Se convierten los eventos al mismo
// formato de mensaje que WhatsApp para reutilizar el inbox, el bot, los escenarios y las
// reglas; al responder se usa la Send API de la página.
const failure = (status, message, meta) => Object.assign(new Error(message), { status, meta });
const HOUR = 60 * 60 * 1000;
const CHANNEL_LABEL = { messenger: 'Messenger', instagram: 'Instagram' };

const config = () => {
  const pageId = process.env.META_PAGE_ID;
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  const version = process.env.META_GRAPH_API_VERSION || process.env.WHATSAPP_GRAPH_API_VERSION;
  if (!pageId || !token || !/^v\d+\.\d+$/.test(version || '')) throw failure(503, 'Messenger/Instagram no está configurado: falta META_PAGE_ID, META_PAGE_ACCESS_TOKEN o la versión de Graph API');
  return { pageId, token, version, instagramId: process.env.META_INSTAGRAM_ACCOUNT_ID || '' };
};
exports.config = config;

/** Canal según el objeto del webhook: «page» = Messenger, «instagram» = Instagram Direct. */
exports.channelFor = (object) => (object === 'page' ? 'messenger' : object === 'instagram' ? 'instagram' : null);
exports.contactKey = (channel, id) => `${channel === 'instagram' ? 'ig' : 'fb'}:${id}`;

const ATTACHMENT_TYPES = { image: 'image', video: 'video', audio: 'audio', file: 'document' };
const httpsUrl = (value) => (typeof value === 'string' && /^https:\/\//i.test(value) ? value : undefined);

/** Anuncio Click-to-Messenger/Direct con los mismos campos que el referral de WhatsApp. */
const referralOf = (referral) => {
  if (!referral || typeof referral !== 'object') return undefined;
  const ad = referral.ads_context_data || {};
  const mapped = {
    source_id: referral.ad_id || ad.post_id || undefined,
    source_type: referral.source === 'ADS' || referral.ad_id ? 'ad' : referral.source ? String(referral.source).toLowerCase() : undefined,
    headline: ad.ad_title || undefined,
    image_url: httpsUrl(ad.photo_url),
    video_url: httpsUrl(ad.video_url),
    source_url: httpsUrl(referral.referer_uri) || httpsUrl(ad.post_url),
    body: referral.ref || undefined,
  };
  return Object.values(mapped).some(Boolean) ? mapped : undefined;
};

/**
 * Convierte un evento de «messaging» en mensajes con forma de WhatsApp.
 * Devuelve [] para ecos, lecturas y entregas (se manejan aparte).
 */
exports.normalizeEvent = (event, channel) => {
  const from = event?.sender?.id;
  if (!from || !channel) return [];
  const base = { from: exports.contactKey(channel, from), timestamp: event.timestamp };
  if (event.reaction?.mid) {
    return [{ ...base, id: `${event.reaction.mid}:reaction:${event.timestamp || ''}`, type: 'reaction', reaction: { message_id: event.reaction.mid, emoji: event.reaction.action === 'unreact' ? '' : event.reaction.emoji || '❤' } }];
  }
  if (event.postback) {
    const id = event.postback.mid || `${from}:postback:${event.timestamp}`;
    return [{ ...base, id, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: event.postback.payload, title: event.postback.title || event.postback.payload } }, ...(referralOf(event.postback.referral) ? { referral: referralOf(event.postback.referral) } : {}) }];
  }
  const message = event.message;
  if (!message?.mid || message.is_echo || message.is_deleted) return [];
  const context = message.reply_to?.mid ? { context: { id: message.reply_to.mid } } : {};
  const referral = referralOf(event.referral || message.referral);
  const extra = { ...context, ...(referral ? { referral } : {}) };
  if (message.quick_reply?.payload) {
    return [{ ...base, ...extra, id: message.mid, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: message.quick_reply.payload, title: message.text || message.quick_reply.payload } } }];
  }
  const items = [];
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  attachments.forEach((attachment, index) => {
    const id = index === 0 && !message.text ? message.mid : `${message.mid}:${index + 1}`;
    const url = httpsUrl(attachment?.payload?.url);
    const isSticker = Boolean(attachment?.payload?.sticker_id) || attachment?.type === 'like_heart';
    const type = isSticker ? 'sticker' : ATTACHMENT_TYPES[attachment?.type];
    if (type && url) items.push({ ...base, ...extra, id, type, [type]: { id: url, ...(type === 'document' ? { filename: attachment.payload.title || attachment.name || 'archivo' } : {}) } });
    else if (url || attachment?.payload?.title) items.push({ ...base, ...extra, id, type: 'text', text: { body: [attachment.payload?.title, url].filter(Boolean).join('\n') } });
  });
  if (message.text) items.unshift({ ...base, ...extra, id: message.mid, type: 'text', text: { body: message.text } });
  return items;
};

/** Ventana para responder: 24 h normal; 7 días si vino de un anuncio o como agente humano. */
exports.sendWindow = ({ lastInboundAt, fromAd = false }, now = Date.now()) => {
  if (!lastInboundAt) return { ok: false, reason: 'El cliente todavía no ha escrito por este canal.' };
  const elapsed = now - new Date(lastInboundAt).getTime();
  if (elapsed <= 24 * HOUR) return { ok: true, messagingType: 'RESPONSE' };
  if (fromAd && elapsed <= 7 * 24 * HOUR) return { ok: true, messagingType: 'RESPONSE' };
  if (elapsed <= 7 * 24 * HOUR) return { ok: true, messagingType: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' };
  return { ok: false, reason: 'Pasaron más de 7 días desde el último mensaje del cliente; Meta no permite responder por este canal hasta que vuelva a escribir.' };
};

const parseJson = (value) => { try { return JSON.parse(value || '{}'); } catch { return {}; } };
const truncate = (value, max) => (String(value || '').length > max ? `${String(value).slice(0, max - 1)}…` : String(value || ''));

/** Arma el contenido de un mensaje de texto u opciones para la Send API. */
exports.textMessage = (message) => {
  if (message.type === 'template') throw failure(400, 'Las plantillas de WhatsApp no se pueden enviar por Messenger o Instagram.');
  if (message.type === 'interactive') {
    const data = parseJson(message.body);
    if (data.kind === 'options') {
      const options = (data.sections ? data.sections.flatMap((section) => section.rows || section.options || []) : data.options || data.buttons || []).slice(0, 13);
      const text = truncate([data.header, data.body, data.footer].filter(Boolean).join('\n\n') || 'Elige una opción:', 2000);
      return { text, quick_replies: options.map((option) => ({ content_type: 'text', title: truncate(option.title, 20), payload: truncate(option.id || option.title, 1000) })) };
    }
    const link = data.url ? `\n${data.url}` : '';
    return { text: truncate(`${[data.header, data.body, data.footer].filter(Boolean).join('\n\n')}${link}` || data.url || 'Enlace', 2000) };
  }
  return { text: truncate(message.body, 2000) };
};

const graph = async (path, { method = 'GET', body, form } = {}) => {
  const { token, version } = config();
  const url = `https://graph.facebook.com/${version}/${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
  let response;
  try {
    response = await fetch(url, {
      method,
      ...(form ? { body: form } : body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(Number(process.env.WHATSAPP_MEDIA_UPLOAD_TIMEOUT_MS || 60000)),
    });
  } catch (error) {
    throw failure(502, 'No se pudo conectar con Meta', { errorType: error.name });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const meta = { code: data.error?.code, subcode: data.error?.error_subcode, message: data.error?.message };
    console.error(JSON.stringify({ level: 'warn', message: 'Meta Send API rejected the request', status: response.status, meta }));
    throw failure(response.status >= 500 ? 502 : 400, meta.message || 'Meta rechazó el mensaje', { ...meta, details: meta.message });
  }
  return data;
};

/** Sube un archivo guardado (media de WhatsApp o URL) para enviarlo por Messenger/Instagram. */
const uploadAttachment = async (channel, type, mediaId, filename) => {
  const media = /^https:\/\//i.test(mediaId)
    ? await fetch(mediaId, { signal: AbortSignal.timeout(30000) }).then(async (response) => { if (!response.ok) throw failure(404, 'El archivo ya no está disponible'); return { contentType: response.headers.get('content-type') || 'application/octet-stream', buffer: Buffer.from(await response.arrayBuffer()) }; })
    : await require('./message.service').downloadMedia(mediaId);
  const form = new FormData();
  form.append('message', JSON.stringify({ attachment: { type, payload: { is_reusable: false } } }));
  form.append('filedata', new Blob([media.buffer], { type: media.contentType }), filename || `archivo.${(media.contentType.split('/')[1] || 'bin').split(';')[0]}`);
  const { pageId } = config();
  const result = await graph(`${pageId}/message_attachments${channel === 'instagram' ? '?platform=instagram' : ''}`, { method: 'POST', form });
  if (!result.attachment_id) throw failure(502, 'Meta no devolvió el archivo subido');
  return result.attachment_id;
};

const OUTBOUND_TYPES = { image: 'image', video: 'video', audio: 'audio', document: 'file', sticker: 'image' };

/**
 * Envía un mensaje pendiente del inbox. `message` trae channel, external_id, last_inbound_at y from_ad.
 * Devuelve { messages: [{ id }] } como el envío de WhatsApp.
 */
exports.send = async (message) => {
  const channel = message.channel;
  if (!CHANNEL_LABEL[channel] || !message.external_id) throw failure(400, 'Contacto sin canal de Messenger/Instagram');
  const window = exports.sendWindow({ lastInboundAt: message.last_inbound_at, fromAd: message.from_ad });
  if (!window.ok) throw failure(400, window.reason);
  const { pageId } = config();
  const envelope = { recipient: { id: message.external_id }, messaging_type: window.messagingType, ...(window.tag ? { tag: window.tag } : {}) };
  const post = (content, replyTo) => graph(`${pageId}/messages`, { method: 'POST', body: { ...envelope, message: content, ...(replyTo ? { reply_to: { mid: replyTo } } : {}) } });
  const attachmentType = OUTBOUND_TYPES[message.type];
  let result;
  if (attachmentType) {
    if (channel === 'instagram' && attachmentType === 'file') throw failure(400, 'Instagram no permite enviar documentos; envía una imagen o el enlace.');
    const attachmentId = await uploadAttachment(channel, attachmentType, message.media_id, message.filename);
    result = await post({ attachment: { type: attachmentType, payload: { attachment_id: attachmentId } } }, message.reply_to_provider_message_id);
    // Messenger e Instagram no tienen pie de foto: el texto va en un mensaje aparte.
    if (message.body?.trim()) await post({ text: truncate(message.body, 2000) });
  } else {
    result = await post(exports.textMessage(message), message.reply_to_provider_message_id);
  }
  console.log(JSON.stringify({ level: 'info', message: `${CHANNEL_LABEL[channel]} message accepted by Meta`, type: message.type }));
  return { accepted: true, messages: [{ id: result.message_id }] };
};

/** Nombre del contacto (Messenger: nombre; Instagram: nombre y usuario). Nunca detiene el guardado. */
exports.profile = async (channel, externalId) => {
  try {
    const fields = channel === 'instagram' ? 'name,username' : 'first_name,last_name';
    const data = await graph(`${encodeURIComponent(externalId)}?fields=${fields}`);
    const name = channel === 'instagram' ? data.name || (data.username ? `@${data.username}` : '') : [data.first_name, data.last_name].filter(Boolean).join(' ');
    return { name: name || null, username: data.username || null };
  } catch {
    return { name: null, username: null };
  }
};

/** La organización dueña de la página/cuenta: META_PAGE_ORGANIZATION_ID o la única existente. */
exports.organizationFor = async (entryId) => {
  const { pageId, instagramId } = config();
  if (entryId !== pageId && (!instagramId || entryId !== instagramId)) return null;
  if (process.env.META_PAGE_ORGANIZATION_ID) return process.env.META_PAGE_ORGANIZATION_ID;
  const only = await db.query('SELECT id FROM organizations ORDER BY created_at LIMIT 2');
  return only.rows.length === 1 ? only.rows[0].id : null;
};

/** Entregas y lecturas de Messenger/Instagram. */
exports.statusUpdates = (event) => {
  const updates = [];
  for (const mid of event?.delivery?.mids || []) updates.push({ id: mid, status: 'delivered' });
  if (event?.read?.mid) updates.push({ id: event.read.mid, status: 'read' });
  if (event?.read?.watermark) updates.push({ watermark: Number(event.read.watermark), status: 'read', sender: event.sender?.id });
  return updates;
};
