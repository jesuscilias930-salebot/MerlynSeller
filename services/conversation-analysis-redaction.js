// Best-effort minimization, not a guarantee of anonymization. The export UI
// requires review before download. No raw metadata, media or contact IDs export.
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const accentPattern = value => [...value.normalize('NFD').replace(/[\u0300-\u036f]/g, '')].map(char => {
  const variants = { a: '[aáàâä]', e: '[eéèêë]', i: '[iíìîï]', o: '[oóòôö]', u: '[uúùûü]', n: '[nñ]' };
  return variants[char.toLowerCase()] || escape(char);
}).join('');
const nonNames = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'cliente', 'contacto', 'whatsapp', 'calceta', 'calcetas', 'tin', 'tines', 'caricatura', 'dama', 'caballero', 'hombre', 'mujer', 'niño', 'niña', 'bebe', 'bebé', 'unisex', 'pedido']);

exports.redactor = contacts => {
  const names = [...new Set(contacts.flatMap(contact => {
    const name = String(contact.name || '').trim().slice(0, 200);
    return name ? [name, ...name.split(/\s+/).filter(word => word.length >= 3 && !nonNames.has(word.toLowerCase()))] : [];
  }))].filter(name => name.length >= 3 && !nonNames.has(name.toLowerCase())).sort((a, b) => b.length - a.length).slice(0, 400);
  const namePattern = names.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.map(accentPattern).join('|')})(?![\\p{L}\\p{N}])`, 'giu') : null;
  return raw => {
    let changes = 0;
    const replace = (text, pattern, replacement) => text.replace(pattern, () => { changes++; return replacement; });
    let text = String(raw || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '');
    text = replace(text, /^\s*(?:nombre(?: completo)?|direcci[oó]n|domicilio|calle|colonia|ciudad|municipio|estado|c[oó]digo postal|c\.?p\.?|tel[eé]fono|celular|correo|e-?mail|rfc|curp|clabe|cuenta(?: bancaria)?|tarjeta|titular|banco)\s*[:=]\s*.+$/gimu, '[DATO PERSONAL OMITIDO]');
    text = replace(text, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[CORREO OMITIDO]');
    text = replace(text, /(?:https?:\/\/|www\.)[^\s<>"']+/giu, '[ENLACE OMITIDO]');
    text = replace(text, /\b[A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3}\b/giu, '[IDENTIFICADOR OMITIDO]');
    text = replace(text, /\b[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d\b/giu, '[IDENTIFICADOR OMITIDO]');
    text = text.replace(/(?<![\p{L}\p{N}])\+?\d[\d ().-]{6,}\d(?![\p{L}\p{N}])/gu, (match, offset, input) => {
      const count = match.replace(/\D/g, '').length;
      if (count < 8) return match;
      if (/(?:[$€£]|MXN|USD)\s*$/iu.test(input.slice(Math.max(0, offset - 12), offset)) || /^\s*(?:MXN|USD)\b/iu.test(input.slice(offset + match.length, offset + match.length + 10))) return match;
      changes++; return '[TELÉFONO O NÚMERO SENSIBLE OMITIDO]';
    });
    text = replace(text, /\b(?:calle|avenida|av\.|colonia|fraccionamiento|fracc\.)\s+[^\n;]{3,160}/giu, '[DIRECCIÓN OMITIDA]');
    if (namePattern) text = replace(text, namePattern, '[NOMBRE OMITIDO]');
    return { text, changes };
  };
};
