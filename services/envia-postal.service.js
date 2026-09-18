const cache = new Map();
const fail = (status, message) => Object.assign(new Error(message), { status });

function normalize(rows, postalCode) {
  const localities = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const stateCode = row?.state?.code?.['2digit'];
    if (row?.zip_code !== postalCode || row?.country?.code !== 'MX' ||
        !/^[A-Z]{2}$/.test(stateCode || '') || !row.state.name || !row.locality) continue;
    const districts = [...new Set((row.suburbs || []).filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()))];
    const existing = localities.find(x => x.stateCode === stateCode && x.city === row.locality);
    if (existing) existing.districts = [...new Set([...existing.districts, ...districts])];
    else localities.push({ stateCode, stateName: row.state.name, city: row.locality, districts });
  }
  return { country: 'MX', postalCode, localities };
}

async function lookup(postalCode) {
  if (!/^\d{5}$/.test(postalCode || '')) throw fail(400, 'Escribe un código postal mexicano de 5 dígitos.');
  const saved = cache.get(postalCode);
  if (saved && saved.expires > Date.now()) return saved.result;
  let result;
  try {
    const response = await fetch(`https://geocodes.envia.com/zipcode/MX/${postalCode}`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('Postal lookup failed');
    result = normalize(await response.json(), postalCode);
  } catch {
    throw fail(502, 'No pudimos consultar las colonias en Envia. Intenta nuevamente.');
  }
  if (!result.localities.length) throw fail(404, 'No encontramos localidades para ese código postal.');
  if (cache.size >= 256) cache.delete(cache.keys().next().value);
  cache.set(postalCode, { result, expires: Date.now() + 3600000 });
  return result;
}
module.exports = { lookup, normalize };
