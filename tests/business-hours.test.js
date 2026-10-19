const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const hours = require('../services/business-hours.service');

const config = (patch = {}) => hours.parse({ ...hours.defaults(), enabled: true, ...patch });
// 2026-10-19 es lunes. México (America/Mexico_City) = UTC-6.
const at = (iso) => new Date(iso);
const MONDAY_NOON = at('2026-10-19T18:00:00Z');
const MONDAY_NIGHT = at('2026-10-20T03:00:00Z'); // lunes 21:00
const TUESDAY_9AM = at('2026-10-20T15:00:00Z');
const SATURDAY_NIGHT = at('2026-10-25T02:00:00Z'); // sábado 20:00

test('abre lunes a sábado de 8 a 18 en hora de México y respeta días cerrados', () => {
  const c = config();
  assert.equal(hours.isOpen(c, MONDAY_NOON), true);
  assert.equal(hours.isOpen(c, MONDAY_NIGHT), false);
  assert.equal(hours.isOpen(c, at('2026-10-19T14:00:00Z')), true, '8:00 en punto abre');
  assert.equal(hours.isOpen(c, at('2026-10-20T00:00:00Z')), false, '18:00 en punto ya cerró');
  assert.equal(hours.isOpen(config({ closedDates: ['2026-10-19'] }), MONDAY_NOON), false);
  assert.equal(hours.describeSchedule(c), 'lunes a sábado de 8:00 a 18:00');
});

test('describe la próxima apertura', () => {
  const c = config();
  assert.equal(hours.describeOpening(c, MONDAY_NIGHT, hours.nextOpening(c, MONDAY_NIGHT)), 'mañana a las 8:00');
  assert.equal(hours.describeOpening(c, SATURDAY_NIGHT, hours.nextOpening(c, SATURDAY_NIGHT)), 'el lunes a las 8:00');
  assert.equal(hours.describeOpening(c, at('2026-10-19T12:00:00Z'), hours.nextOpening(c, at('2026-10-19T12:00:00Z'))), 'hoy a las 8:00');
  const split = config({ schedule: hours.defaults().schedule.map((day) => day.day === 1 ? { ...day, intervals: [{ start: '08:00', end: '14:00' }, { start: '16:30', end: '19:00' }] } : day) });
  assert.equal(hours.describeOpening(split, at('2026-10-19T21:00:00Z'), hours.nextOpening(split, at('2026-10-19T21:00:00Z'))), 'hoy a las 16:30');
  assert.equal(hours.nextOpening(config({ schedule: hours.defaults().schedule.map((day) => ({ ...day, open: false, intervals: [] })) }), MONDAY_NIGHT), null);
});

test('elige el mensaje según lo que escribe el cliente', () => {
  const c = config({ rules: [
    { id: 'precios', name: 'Precios', examples: ['precio', 'cuanto cuesta', 'lista de precios'], body: 'Mañana te compartimos precios. Abrimos {{proxima_apertura}}.' },
    { id: 'envios', name: 'Envíos', examples: ['hacen envios', 'envio a'], body: 'Sí enviamos a todo México.' },
  ] });
  assert.equal(hours.evaluate(c, '¿Cuánto cuesta el paquete?', MONDAY_NIGHT).message, 'Mañana te compartimos precios. Abrimos mañana a las 8:00.');
  assert.equal(hours.evaluate(c, 'hacen envíos a Monterrey?', MONDAY_NIGHT).rule.id, 'envios');
  const general = hours.evaluate(c, 'hola', MONDAY_NIGHT);
  assert.equal(general.rule, null);
  assert.match(general.message, /fuera de horario \(lunes a sábado de 8:00 a 18:00\)\. Te respondemos mañana a las 8:00/);
  assert.equal(hours.evaluate(c, 'precio', MONDAY_NOON).message, null, 'en horario no se responde');
});

test('valida el horario con mensajes claros', () => {
  const schedule = hours.defaults().schedule;
  assert.throws(() => config({ schedule: schedule.map((d) => d.day === 2 ? { ...d, intervals: [{ start: '18:00', end: '08:00' }] } : d) }), { status: 400, message: /martes: la hora de cierre/ });
  assert.throws(() => config({ schedule: schedule.map((d) => d.day === 3 ? { ...d, intervals: [{ start: '08:00', end: '14:00' }, { start: '13:00', end: '18:00' }] } : d) }), /miércoles tiene horarios que se enciman/);
  assert.throws(() => config({ defaultMessage: '' }), /mensaje general/);
  assert.throws(() => config({ timezone: 'Marte/Base' }), /Zona horaria/);
  assert.throws(() => config({ rules: [{ id: 'a', name: 'X', examples: [], body: 'y' }] }), /al menos una frase/);
});

// Mensajes en el pasado: un timestamp futuro se trata como "ahora".
test('envía un aviso por periodo cerrado y detiene las automatizaciones', async () => {
  const original = db.query; const sent = []; let moved = 0;
  let row = { auto_reply_enabled: true, after_hours_notified_at: null };
  const stored = { config: config() };
  db.query = async (sql, args) => {
    if (sql.includes('FROM business_hours_settings')) return { rows: [stored] };
    if (sql.startsWith('SELECT auto_reply_enabled')) return { rows: [row] };
    if (sql.startsWith('UPDATE conversations SET after_hours_notified_at')) {
      if ((row.after_hours_notified_at || null)?.valueOf?.() !== (args[3] || null)?.valueOf?.() && !(row.after_hours_notified_at == null && args[3] == null)) return { rows: [] };
      row = { ...row, after_hours_notified_at: args[2] }; return { rows: [{ id: 'c' }] };
    }
    return { rows: [] };
  };
  const deps = { conversations: { queueText: async (_o, _c, input) => sent.push(input.body) }, leads: { moveToAttention: async () => { moved += 1; } } };
  const message = (iso, body = 'hola') => ({ id: iso, type: 'text', text: { body }, timestamp: String(Date.parse(iso) / 1000) });
  try {
    assert.deepEqual(await hours.handleIncoming('o', 'c', message('2026-10-13T03:00:00Z'), deps), { handled: true, notified: true, rule: null });
    assert.deepEqual(await hours.handleIncoming('o', 'c', message('2026-10-13T04:00:00Z'), deps), { handled: true, notified: false }, 'misma noche: no repite');
    assert.deepEqual(await hours.handleIncoming('o', 'c', message('2026-10-13T15:00:00Z'), deps), { handled: false }, 'en horario no interviene');
    assert.equal((await hours.handleIncoming('o', 'c', message('2026-10-14T03:00:00Z'), deps)).notified, true, 'otra noche: avisa de nuevo');
    assert.equal(sent.length, 2); assert.equal(moved, 2);
    row.auto_reply_enabled = false;
    assert.deepEqual(await hours.handleIncoming('o', 'c', message('2026-10-15T03:00:00Z'), deps), { handled: false }, 'bot pausado: no responde');
    row.auto_reply_enabled = true;
    stored.config = config({ continueAutomations: true });
    assert.equal((await hours.handleIncoming('o', 'c', message('2026-10-16T03:00:00Z'), deps)).handled, false, 'puede dejar seguir a escenarios');
    stored.config = config({ enabled: false, defaultMessage: '' });
    assert.deepEqual(await hours.handleIncoming('o', 'c', message('2026-10-17T03:00:00Z'), deps), { handled: false });
    assert.deepEqual(await hours.handleIncoming('o', 'c', { id: 'r', type: 'reaction' }, deps), { handled: false });
  } finally { db.query = original; }
});
