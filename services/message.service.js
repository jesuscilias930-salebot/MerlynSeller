const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

class MessageError extends Error {
  constructor(status, message, meta = undefined) {
    super(message);
    this.name = 'MessageError';
    this.status = status;
    this.meta = meta;
  }

  toResponse() {
    return this.meta ? { error: this.message, meta: this.meta } : { error: this.message };
  }
}

const safeEqual = (received, expected) => {
  if (typeof received !== 'string' || typeof expected !== 'string') return false;
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
};

const requiredString = (value, field, maximumLength) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MessageError(400, `${field} is required`);
  }
  const normalized = value.trim();
  if (maximumLength && normalized.length > maximumLength) {
    throw new MessageError(400, `${field} exceeds the maximum length`);
  }
  return normalized;
};

const recipient = (value) => {
  const normalized = requiredString(value, 'to').replace(/^\+/, '');
  if (!/^\d{8,15}$/.test(normalized)) {
    throw new MessageError(400, 'to must be an E.164 phone number with country code');
  }
  return normalized;
};

const httpsUrl = (value, field) => {
  const raw = requiredString(value, field, 2048);
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') throw new Error('insecure protocol');
    return parsed.toString();
  } catch {
    throw new MessageError(400, `${field} must be a valid HTTPS URL`);
  }
};

const mediaReference = (input) => {
  const hasId = typeof input.id === 'string' && input.id.trim().length > 0;
  const hasLink = typeof input.link === 'string' && input.link.trim().length > 0;
  if (hasId === hasLink) {
    throw new MessageError(400, 'Provide exactly one of id or link');
  }
  return hasId ? { id: requiredString(input.id, 'id', 256) } : { link: httpsUrl(input.link, 'link') };
};

const optionalText = (value, field, maximumLength) => (
  value === undefined ? undefined : requiredString(value, field, maximumLength)
);

const metaAudioTypes = new Set(['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/amr', 'audio/ogg', 'audio/opus']);

const convertWebmToOgg = (buffer) => new Promise((resolve, reject) => {
  const process = spawn('ffmpeg', ['-i', 'pipe:0', '-vn', '-c:a', 'libopus', '-f', 'ogg', 'pipe:1'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = [];
  let errorOutput = '';
  const timeout = setTimeout(() => process.kill('SIGKILL'), Number(process.env.AUDIO_CONVERSION_TIMEOUT_MS || 30000));
  process.stdout.on('data', (chunk) => output.push(chunk));
  process.stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
  process.on('error', (error) => {
    clearTimeout(timeout);
    if (error.code === 'ENOENT') return reject(new MessageError(503, 'Audio conversion is not available'));
    return reject(new MessageError(500, 'Audio conversion failed'));
  });
  process.on('close', (code) => {
    clearTimeout(timeout);
    if (code !== 0) {
      console.warn(JSON.stringify({ level: 'warn', message: 'Audio conversion failed', exitCode: code, details: errorOutput.slice(-300) }));
      return reject(new MessageError(400, 'Unable to convert the recorded audio'));
    }
    return resolve(Buffer.concat(output));
  });
  process.stdin.end(buffer);
});

const graphConfig = () => {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const version = process.env.WHATSAPP_GRAPH_API_VERSION;
  if (!accessToken || !phoneNumberId || !/^v\d+\.\d+$/.test(version || '')) {
    throw new MessageError(503, 'WhatsApp messaging is not configured');
  }
  return {
    accessToken,
    phoneNumberId,
    version,
  };
};

const metaError = (payload) => {
  const error = payload?.error;
  if (!error) return undefined;
  return {
    code: error.code,
    type: error.type,
    message: error.message,
  };
};

const send = async (payload) => {
  const { accessToken, phoneNumberId, version } = graphConfig();
  let response;
  try {
    response = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(Number(process.env.WHATSAPP_REQUEST_TIMEOUT_MS || 10000)),
    });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'Meta request failed', errorType: error.name }));
    throw new MessageError(502, 'Unable to reach Meta');
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(JSON.stringify({ level: 'warn', message: 'Meta rejected message', status: response.status }));
    throw new MessageError(response.status >= 500 ? 502 : 400, 'Meta rejected the message', metaError(body));
  }

  console.log(JSON.stringify({ level: 'info', message: 'WhatsApp message accepted by Meta', type: payload.type }));
  return { accepted: true, messages: body.messages || [] };
};

exports.uploadMedia = async ({ buffer, contentType, filename }) => {
  const { accessToken, phoneNumberId, version } = graphConfig();
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buffer], { type: contentType }), filename);
  let response;
  try {
    response = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
      signal: AbortSignal.timeout(Number(process.env.WHATSAPP_REQUEST_TIMEOUT_MS || 10000)),
    });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'Meta media upload failed', errorType: error.name }));
    throw new MessageError(502, 'Unable to reach Meta');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.id) {
    console.error(JSON.stringify({ level: 'warn', message: 'Meta rejected image upload', status: response.status }));
    throw new MessageError(response.status >= 500 ? 502 : 400, 'Meta rejected the image', metaError(body));
  }
  console.log(JSON.stringify({ level: 'info', message: 'Media uploaded to Meta' }));
  return { mediaId: body.id, filename };
};

exports.uploadImage = (input) => exports.uploadMedia(input);

exports.prepareAudio = async ({ buffer, contentType, filename }) => {
  const normalizedType = String(contentType || '').toLowerCase();
  if (metaAudioTypes.has(normalizedType)) {
    return { buffer, contentType: normalizedType, filename: requiredString(filename, 'filename', 240) };
  }
  if (normalizedType === 'audio/webm') {
    const converted = await convertWebmToOgg(buffer);
    return { buffer: converted, contentType: 'audio/ogg', filename: 'recording.ogg' };
  }
  throw new MessageError(400, 'Unsupported audio format');
};

exports.downloadMedia = async (mediaId) => {
  const { accessToken, version } = graphConfig();
  const safeMediaId = requiredString(mediaId, 'mediaId', 256);
  let metadata;
  try {
    metadata = await fetch(`https://graph.facebook.com/${version}/${safeMediaId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(Number(process.env.WHATSAPP_REQUEST_TIMEOUT_MS || 10000)),
    });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'Meta media lookup failed', errorType: error.name }));
    throw new MessageError(502, 'Unable to reach Meta');
  }
  const details = await metadata.json().catch(() => ({}));
  if (!metadata.ok || !details.url) throw new MessageError(metadata.status >= 500 ? 502 : 404, 'Media is not available', metaError(details));

  let file;
  try {
    file = await fetch(details.url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(Number(process.env.WHATSAPP_REQUEST_TIMEOUT_MS || 10000)),
    });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'Meta media download failed', errorType: error.name }));
    throw new MessageError(502, 'Unable to reach Meta');
  }
  if (!file.ok) throw new MessageError(file.status >= 500 ? 502 : 404, 'Media is not available');
  return {
    contentType: file.headers.get('content-type') || details.mime_type || 'application/octet-stream',
    buffer: Buffer.from(await file.arrayBuffer()),
  };
};

exports.MessageError = MessageError;
exports.isOutboundApiKeyValid = (key) => safeEqual(key, process.env.OUTBOUND_API_KEY);

exports.sendText = async (input) => send({
  messaging_product: 'whatsapp',
  recipient_type: 'individual',
  to: recipient(input.to),
  type: 'text',
  text: {
    preview_url: input.previewUrl === true,
    body: requiredString(input.body, 'body', 4096),
  },
});

exports.sendVideo = async (input) => {
  const caption = optionalText(input.caption, 'caption', 1024);
  const video = {
    ...mediaReference(input),
    ...(caption ? { caption } : {}),
  };
  return send({ messaging_product: 'whatsapp', recipient_type: 'individual', to: recipient(input.to), type: 'video', video });
};

exports.sendAttachment = async (input) => {
  const type = requiredString(input.type, 'type');
  if (!['document', 'image', 'audio', 'sticker'].includes(type)) {
    throw new MessageError(400, 'type must be document, image, audio, or sticker');
  }

  const attachment = { ...mediaReference(input) };
  const caption = optionalText(input.caption, 'caption', 1024);
  if (caption && ['document', 'image'].includes(type)) attachment.caption = caption;
  if (caption && !['document', 'image'].includes(type)) {
    throw new MessageError(400, `caption is not supported for ${type}`);
  }
  if (input.filename !== undefined) {
    if (type !== 'document') throw new MessageError(400, 'filename is only supported for document');
    attachment.filename = requiredString(input.filename, 'filename', 240);
  }

  return send({ messaging_product: 'whatsapp', recipient_type: 'individual', to: recipient(input.to), type, [type]: attachment });
};

exports.sendCtaUrl = async (input) => {
  const interactive = {
    type: 'cta_url',
    body: { text: requiredString(input.body, 'body', 1024) },
    action: {
      name: 'cta_url',
      parameters: {
        display_text: requiredString(input.buttonText, 'buttonText', 20),
        url: httpsUrl(input.url, 'url'),
      },
    },
  };
  const header = optionalText(input.header, 'header', 60);
  const footer = optionalText(input.footer, 'footer', 60);
  if (header) interactive.header = { type: 'text', text: header };
  if (footer) interactive.footer = { text: footer };

  return send({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: recipient(input.to),
    type: 'interactive',
    interactive,
  });
};
