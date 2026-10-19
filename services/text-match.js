// Comparación tolerante de frases en español (acentos, mayúsculas y errores
// de dedo) compartida por escenarios y mensajes fuera de horario.
const normalize = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
const words = (value) =>
  normalize(value)
    .split(" ")
    .filter((word) => word.length > 1);
const levenshtein = (left, right) => {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const current = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        previous + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      previous = current;
    }
  }
  return row[right.length];
};
const similar = (left, right) =>
  left === right ||
  (left.length >= 3 &&
    right.length >= 3 &&
    levenshtein(left, right) <=
      Math.max(1, Math.floor(Math.max(left.length, right.length) * 0.25)));
const score = (text, examples) =>
  Math.max(
    0,
    ...(examples || []).map((example) => {
      const phrase = normalize(example);
      if (!phrase) return 0;
      if (text.includes(phrase)) return 1;
      const phraseWords = words(phrase);
      const textWords = words(text);
      return phraseWords.length
        ? phraseWords.filter((word) =>
            textWords.some((candidate) => similar(word, candidate)),
          ).length / phraseWords.length
        : 0;
    }),
  );

module.exports = { normalize, words, similar, score };
