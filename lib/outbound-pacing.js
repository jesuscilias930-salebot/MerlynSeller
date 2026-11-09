// Orden de entrega en el teléfono del cliente: WhatsApp/Meta aceptan un video en milisegundos,
// pero tarda en llegar al cliente; un texto enviado justo después llega antes y los mensajes se
// ven al revés. Tras enviar un archivo, si hay otro mensaje en cola para ese chat, se espera a que
// Meta confirme la entrega (o un tiempo máximo, si el cliente no tiene conexión).
const MAX_WAIT_MS = {
  video: Number(process.env.OUTBOUND_VIDEO_WAIT_MS || 30000),
  document: Number(process.env.OUTBOUND_DOCUMENT_WAIT_MS || 12000),
  image: Number(process.env.OUTBOUND_IMAGE_WAIT_MS || 8000),
  audio: Number(process.env.OUTBOUND_IMAGE_WAIT_MS || 8000),
  sticker: 4000,
};
const DONE = new Set(['delivered', 'read', 'failed']);

exports.maxWaitFor = (type) => MAX_WAIT_MS[type] || 0;

/**
 * Espera a que el mensaje quede entregado. `hasNext()` evita esperar si no hay nada detrás;
 * `keepAlive()` renueva el candado del chat mientras se espera (si lo pierde, deja de esperar).
 * Devuelve { waited, reason } para los logs.
 */
exports.waitForDelivery = async ({ db, messageId, type, hasNext, keepAlive, intervalMs = 1000, now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) => {
  const maxWait = exports.maxWaitFor(type);
  if (!maxWait) return { waited: 0, reason: 'not_media' };
  if (!(await hasNext())) return { waited: 0, reason: 'nothing_after' };
  const started = now();
  for (;;) {
    const status = (await db.query('SELECT status FROM messages WHERE id = $1', [messageId])).rows[0]?.status;
    if (DONE.has(status)) return { waited: now() - started, reason: status };
    if (now() - started >= maxWait) return { waited: now() - started, reason: 'timeout' };
    if (keepAlive && !(await keepAlive())) return { waited: now() - started, reason: 'lock_lost' };
    await sleep(intervalMs);
  }
};
