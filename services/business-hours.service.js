const { z } = require('zod');
const db = require('../lib/db');
const { normalize, score } = require('./text-match');

// Horario de atención y avisos fuera de horario. Los horarios se guardan en la
// zona horaria del negocio y se evalúan contra la hora del mensaje del cliente.
const DAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const STEP_MS = 5 * 60 * 1000;
const SEARCH_DAYS = 45;
const RULE_THRESHOLD = 0.65;
// Tipos que escribe o envía el cliente; avisos de sistema o reacciones no cuentan.
const CUSTOMER_TYPES = new Set(['text', 'interactive', 'button', 'image', 'audio', 'video', 'document', 'sticker', 'location', 'contacts', 'order']);

const fail = (message) => { const error = new Error(message); error.status = 400; throw error; };
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'Usa horas con formato HH:MM');
const minutes = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
const validTimezone = (value) => { try { new Intl.DateTimeFormat('es-MX', { timeZone: value }); return true; } catch { return false; } };

const ruleSchema = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1, 'Ponle nombre a cada mensaje').max(100),
  examples: z.array(z.string().trim().min(1).max(240)).min(1, 'Agrega al menos una frase a cada mensaje').max(30),
  body: z.string().trim().min(1, 'Escribe el texto de cada mensaje').max(4096),
});
const configSchema = z.object({
  enabled: z.boolean().default(false),
  timezone: z.string().trim().refine(validTimezone, 'Zona horaria inválida').default('America/Mexico_City'),
  schedule: z.array(z.object({
    day: z.number().int().min(0).max(6),
    open: z.boolean(),
    intervals: z.array(z.object({ start: time, end: time })).max(3),
  })).length(7),
  closedDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida')).max(60).default([]),
  defaultMessage: z.string().trim().max(4096).default(''),
  rules: z.array(ruleSchema).max(20).default([]),
  moveToAttention: z.boolean().default(true),
  continueAutomations: z.boolean().default(false),
}).superRefine((value, ctx) => {
  const days = new Set(value.schedule.map((day) => day.day));
  if (days.size !== 7) ctx.addIssue({ code: 'custom', message: 'El horario debe incluir los 7 días' });
  for (const day of value.schedule) {
    if (day.open && !day.intervals.length) ctx.addIssue({ code: 'custom', message: `Agrega un horario al ${DAY_NAMES[day.day]} o márcalo como cerrado` });
    const sorted = [...day.intervals].sort((a, b) => minutes(a.start) - minutes(b.start));
    sorted.forEach((interval, index) => {
      if (minutes(interval.end) <= minutes(interval.start)) ctx.addIssue({ code: 'custom', message: `El ${DAY_NAMES[day.day]}: la hora de cierre debe ser después de la de apertura` });
      if (index && minutes(interval.start) < minutes(sorted[index - 1].end)) ctx.addIssue({ code: 'custom', message: `El ${DAY_NAMES[day.day]} tiene horarios que se enciman` });
    });
  }
  if (value.enabled && !value.defaultMessage) ctx.addIssue({ code: 'custom', message: 'Escribe el mensaje general fuera de horario' });
  const ids = new Set();
  for (const rule of value.rules) { if (ids.has(rule.id)) ctx.addIssue({ code: 'custom', message: 'Hay mensajes repetidos' }); ids.add(rule.id); }
});

const weekdays = (start, end) => [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: day !== 0, intervals: day !== 0 ? [{ start, end }] : [] }));
exports.defaults = () => ({
  enabled: false,
  timezone: 'America/Mexico_City',
  schedule: weekdays('08:00', '18:00'),
  closedDates: [],
  defaultMessage: '¡Hola! 👋 Gracias por escribirnos. En este momento estamos fuera de horario ({{horario}}). Te respondemos {{proxima_apertura}}.',
  rules: [],
  moveToAttention: true,
  continueAutomations: false,
});

exports.parse = (input) => {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    fail(issue.code === 'custom' || /^[A-ZÁÉÍÓÚ]/.test(issue.message) && !/^(Too|Invalid|Expected)/.test(issue.message) ? issue.message : 'Revisa los datos del horario');
  }
  const value = parsed.data;
  return {
    ...value,
    schedule: [...value.schedule].sort((a, b) => a.day - b.day).map((day) => ({
      ...day, intervals: day.open ? [...day.intervals].sort((a, b) => minutes(a.start) - minutes(b.start)) : [],
    })),
    closedDates: [...new Set(value.closedDates)].sort(),
  };
};

// --- Cálculo de horario -------------------------------------------------
const partsFormatters = new Map();
const localParts = (date, timezone) => {
  if (!partsFormatters.has(timezone)) partsFormatters.set(timezone, new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
  }));
  const parts = Object.fromEntries(partsFormatters.get(timezone).formatToParts(date).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    hour: Number(parts.hour), minute: Number(parts.minute), month: Number(parts.month), dayOfMonth: Number(parts.day),
  };
};
exports.localParts = localParts;

exports.isOpen = (config, at = new Date()) => {
  const local = localParts(at, config.timezone);
  if ((config.closedDates || []).includes(local.date)) return false;
  const day = config.schedule.find((item) => item.day === local.day);
  return Boolean(day?.open && day.intervals.some((interval) => local.minutes >= minutes(interval.start) && local.minutes < minutes(interval.end)));
};

exports.nextOpening = (config, at = new Date()) => {
  if (!config.schedule.some((day) => day.open && day.intervals.length)) return null;
  const start = Math.ceil(at.getTime() / 60000) * 60000;
  for (let time = start; time <= start + SEARCH_DAYS * 86400000; time += STEP_MS) {
    if (!exports.isOpen(config, new Date(time))) continue;
    let exact = time; // afina al minuto
    while (exact - 60000 > at.getTime() && exports.isOpen(config, new Date(exact - 60000))) exact -= 60000;
    return new Date(exact);
  }
  return null;
};

exports.openBetween = (config, from, to) => {
  if (to.getTime() - from.getTime() > SEARCH_DAYS * 86400000) return true;
  for (let time = from.getTime(); time <= to.getTime(); time += STEP_MS) if (exports.isOpen(config, new Date(time))) return true;
  return exports.isOpen(config, to);
};

const clock = (local) => `${local.hour}:${String(local.minute).padStart(2, '0')}`;
exports.describeOpening = (config, at, opening) => {
  if (!opening) return 'en cuanto volvamos a abrir';
  const now = localParts(at, config.timezone);
  const then = localParts(opening, config.timezone);
  const days = Math.round((Date.UTC(...then.date.split('-').map((v, i) => i === 1 ? v - 1 : +v)) - Date.UTC(...now.date.split('-').map((v, i) => i === 1 ? v - 1 : +v))) / 86400000);
  const when = days === 0 ? 'hoy' : days === 1 ? 'mañana' : days < 7 ? `el ${DAY_NAMES[then.day]}` : `el ${then.dayOfMonth} de ${MONTHS[then.month - 1]}`;
  return `${when} a las ${clock(then)}`;
};

const hour = (value) => value === '24:00' ? '24:00' : `${Number(value.slice(0, 2))}:${value.slice(3)}`;
exports.describeSchedule = (config) => {
  const order = [1, 2, 3, 4, 5, 6, 0];
  const label = (day) => { const item = config.schedule.find((entry) => entry.day === day); return item?.open ? item.intervals.map((i) => `${hour(i.start)} a ${hour(i.end)}`).join(' y ') : ''; };
  const groups = [];
  for (const day of order) {
    const text = label(day); if (!text) continue;
    const last = groups[groups.length - 1];
    if (last && last.text === text && order.indexOf(day) === order.indexOf(last.to) + 1) last.to = day;
    else groups.push({ from: day, to: day, text });
  }
  if (!groups.length) return 'sin horario de atención';
  return groups.map((group) => `${group.from === group.to ? DAY_NAMES[group.from] : `${DAY_NAMES[group.from]} a ${DAY_NAMES[group.to]}`} de ${group.text}`).join(', ');
};

exports.render = (config, body, at) => body
  .replaceAll('{{proxima_apertura}}', exports.describeOpening(config, at, exports.nextOpening(config, at)))
  .replaceAll('{{horario}}', exports.describeSchedule(config));

exports.ruleFor = (config, text) => {
  const normalized = normalize(text);
  if (!normalized) return null;
  const ranked = (config.rules || []).map((rule, index) => ({ rule, index, value: score(normalized, rule.examples) }))
    .sort((a, b) => b.value - a.value || a.index - b.index);
  return ranked[0]?.value >= RULE_THRESHOLD ? ranked[0].rule : null;
};

/** Lo que pasaría con un mensaje del cliente a una hora dada (sin enviar nada). */
exports.evaluate = (config, text, at = new Date()) => {
  const open = exports.isOpen(config, at);
  const opening = open ? null : exports.nextOpening(config, at);
  const rule = open ? null : exports.ruleFor(config, text);
  return {
    open,
    nextOpening: opening ? opening.toISOString() : null,
    nextOpeningText: open ? null : exports.describeOpening(config, at, opening),
    schedule: exports.describeSchedule(config),
    rule: rule ? { id: rule.id, name: rule.name } : null,
    message: open ? null : exports.render(config, rule?.body || config.defaultMessage, at),
  };
};

// --- Persistencia -------------------------------------------------------
exports.get = async (organizationId) => {
  const row = (await db.query('SELECT config FROM business_hours_settings WHERE organization_id=$1', [organizationId])).rows[0];
  return row ? exports.parse({ ...exports.defaults(), ...row.config }) : exports.defaults();
};
exports.save = async (organizationId, input) => {
  const config = exports.parse(input);
  await db.query(
    'INSERT INTO business_hours_settings (organization_id, config) VALUES ($1, $2::jsonb) ON CONFLICT (organization_id) DO UPDATE SET config=EXCLUDED.config, updated_at=now()',
    [organizationId, JSON.stringify(config)],
  );
  return config;
};
exports.status = (config, at = new Date()) => {
  const open = exports.isOpen(config, at);
  const opening = open ? null : exports.nextOpening(config, at);
  return { open, nextOpening: opening ? opening.toISOString() : null, nextOpeningText: open ? null : exports.describeOpening(config, at, opening), schedule: exports.describeSchedule(config) };
};

const messageTime = (message) => {
  const seconds = Number(message?.timestamp);
  const at = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
  return at.getTime() > Date.now() ? new Date() : at;
};
const textOf = (message) => message.text?.body || message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || message.button?.text || message[message.type]?.caption || '';

/**
 * Atiende un mensaje entrante fuera de horario. Envía un aviso por periodo
 * cerrado y conversación; devuelve handled=true cuando las automatizaciones
 * no deben responder también.
 */
exports.handleIncoming = async (organizationId, conversationId, message, deps = {}) => {
  if (!CUSTOMER_TYPES.has(message?.type)) return { handled: false };
  const config = await exports.get(organizationId);
  if (!config.enabled) return { handled: false };
  const at = messageTime(message);
  if (exports.isOpen(config, at)) return { handled: false };
  const conversation = (await db.query('SELECT auto_reply_enabled, after_hours_notified_at FROM conversations WHERE id=$1 AND organization_id=$2', [conversationId, organizationId])).rows[0];
  if (!conversation || conversation.auto_reply_enabled === false) return { handled: false };
  const handled = !config.continueAutomations;
  const previous = conversation.after_hours_notified_at ? new Date(conversation.after_hours_notified_at) : null;
  if (previous && !exports.openBetween(config, previous, at)) return { handled, notified: false };
  // Compara y fija para que dos mensajes simultáneos no envíen dos avisos.
  const claimed = await db.query(
    'UPDATE conversations SET after_hours_notified_at=$3 WHERE id=$1 AND organization_id=$2 AND after_hours_notified_at IS NOT DISTINCT FROM $4 RETURNING id',
    [conversationId, organizationId, at, conversation.after_hours_notified_at || null],
  );
  if (!claimed.rows[0]) return { handled, notified: false };
  const rule = exports.ruleFor(config, textOf(message));
  const conversations = deps.conversations || require('./conversation.service');
  const leads = deps.leads || require('./lead.service');
  await conversations.queueText(organizationId, conversationId, { body: exports.render(config, rule?.body || config.defaultMessage, at) });
  if (config.moveToAttention) await leads.moveToAttention(organizationId, conversationId);
  console.log(JSON.stringify({ level: 'info', message: 'After-hours message sent', conversationId, rule: rule?.id || null }));
  return { handled, notified: true, rule: rule?.id || null };
};
