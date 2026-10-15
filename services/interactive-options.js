// Mensajes interactivos con opciones (botones de respuesta o lista) de WhatsApp.
// Meta limita: 3 botones de respuesta (título ≤ 20) o 10 filas de lista
// (título ≤ 24, descripción ≤ 72). El formato "auto" elige botones solo cuando
// caben sin recortar nada; en cualquier otro caso usa lista.
const LIMITS = Object.freeze({
  buttons: 3, rows: 10, buttonTitle: 20, rowTitle: 24, rowDescription: 72,
  body: 1024, header: 60, footer: 60, listButton: 20, sectionTitle: 24, id: 200,
});
const FORMATS = new Set(['auto', 'buttons', 'list']);
const DEFAULT_LIST_BUTTON = 'Ver opciones';

const fail = (message) => { const error = new Error(message); error.status = 400; throw error; };
const text = (value, label, max, required = false) => {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    if (required) fail(`${label} es obligatorio.`);
    return undefined;
  }
  if (typeof value !== 'string') fail(`${label} debe ser texto.`);
  const normalized = value.trim();
  if ([...normalized].length > max) fail(`${label} admite máximo ${max} caracteres.`);
  return normalized;
};
const length = (value) => [...(value || '')].length;

const slug = (value) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);

const optionIds = (options) => {
  const used = new Set();
  return options.map((option, index) => {
    let id = option.id ? text(option.id, `El identificador de la opción ${index + 1}`, LIMITS.id) : undefined;
    if (id && !/^[\w.:-]+$/.test(id)) fail(`El identificador de la opción ${index + 1} solo admite letras, números, guion, punto y dos puntos.`);
    if (id && used.has(id)) fail('Cada opción debe tener un identificador distinto.');
    if (!id) {
      const base = slug(option.title) || `opcion_${index + 1}`;
      id = base; let suffix = 2;
      while (used.has(id)) id = `${base}_${suffix++}`;
    }
    used.add(id);
    return id;
  });
};

exports.LIMITS = LIMITS;

exports.normalize = (input = {}) => {
  if (!input || typeof input !== 'object') fail('Datos del mensaje inválidos.');
  const requested = input.format === undefined ? 'auto' : input.format;
  if (!FORMATS.has(requested)) fail('El formato debe ser auto, buttons o list.');
  if (!Array.isArray(input.options) || input.options.length === 0) fail('Agrega al menos una opción.');
  if (input.options.length > LIMITS.rows) fail(`WhatsApp permite máximo ${LIMITS.rows} opciones por mensaje.`);

  const raw = input.options.map((option, index) => {
    if (!option || typeof option !== 'object') fail(`La opción ${index + 1} es inválida.`);
    return {
      id: option.id,
      title: text(option.title, `El texto de la opción ${index + 1}`, LIMITS.rowTitle, true),
      description: text(option.description, `La descripción de la opción ${index + 1}`, LIMITS.rowDescription),
    };
  });
  const titles = new Set();
  for (const option of raw) {
    const key = option.title.toLocaleLowerCase('es');
    if (titles.has(key)) fail(`La opción "${option.title}" está repetida.`);
    titles.add(key);
  }
  const fitsButtons = raw.length <= LIMITS.buttons && raw.every((option) => !option.description && length(option.title) <= LIMITS.buttonTitle);
  const format = requested === 'auto' ? (fitsButtons ? 'buttons' : 'list') : requested;
  if (format === 'buttons' && !fitsButtons) {
    if (raw.length > LIMITS.buttons) fail(`Los botones permiten máximo ${LIMITS.buttons} opciones. Usa el formato de lista.`);
    if (raw.some((option) => option.description)) fail('Los botones no admiten descripción. Usa el formato de lista.');
    fail(`El texto de cada botón admite máximo ${LIMITS.buttonTitle} caracteres. Usa el formato de lista.`);
  }
  const ids = optionIds(raw);
  const message = {
    format,
    header: text(input.header, 'El encabezado', LIMITS.header),
    body: text(input.body, 'El texto del mensaje', LIMITS.body, true),
    footer: text(input.footer, 'El pie de mensaje', LIMITS.footer),
    options: raw.map((option, index) => ({ id: ids[index], title: option.title, ...(option.description ? { description: option.description } : {}) })),
  };
  if (format === 'list') {
    message.buttonText = text(input.buttonText, 'El texto del botón de la lista', LIMITS.listButton) || DEFAULT_LIST_BUTTON;
    const sectionTitle = text(input.sectionTitle, 'El título de la sección', LIMITS.sectionTitle);
    if (sectionTitle) message.sectionTitle = sectionTitle;
  }
  for (const key of Object.keys(message)) if (message[key] === undefined) delete message[key];
  return message;
};

exports.toInteractive = (input) => {
  const message = exports.normalize(input);
  const interactive = message.format === 'buttons'
    ? {
      type: 'button',
      body: { text: message.body },
      action: { buttons: message.options.map((option) => ({ type: 'reply', reply: { id: option.id, title: option.title } })) },
    }
    : {
      type: 'list',
      body: { text: message.body },
      action: {
        button: message.buttonText,
        sections: [{
          ...(message.sectionTitle ? { title: message.sectionTitle } : {}),
          rows: message.options.map((option) => ({ id: option.id, title: option.title, ...(option.description ? { description: option.description } : {}) })),
        }],
      },
    };
  if (message.header) interactive.header = { type: 'text', text: message.header };
  if (message.footer) interactive.footer = { text: message.footer };
  return interactive;
};

// Texto legible para la bandeja (último mensaje) y análisis.
exports.summary = (message) => message?.body || 'Mensaje con opciones';
