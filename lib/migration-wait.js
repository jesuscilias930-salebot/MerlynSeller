const fs = require('node:fs');
const path = require('node:path');

/** Espera a que todas las migraciones de db/migrations estén aplicadas (máximo `timeoutMs`). */
module.exports = async (db, { timeoutMs = Number(process.env.MIGRATION_WAIT_TIMEOUT_MS || 600000), intervalMs = 5000, directory = path.join(__dirname, '..', 'db', 'migrations') } = {}) => {
  if (process.env.SKIP_MIGRATION_WAIT === 'true') return true;
  const expected = fs.readdirSync(directory).filter((file) => file.endsWith('.sql'));
  const deadline = Date.now() + timeoutMs;
  let warned = false;
  for (;;) {
    let missing = expected;
    try {
      const applied = new Set((await db.query('SELECT filename FROM schema_migrations')).rows.map((row) => row.filename));
      missing = expected.filter((file) => !applied.has(file));
    } catch { /* La tabla aún no existe: la API todavía no corre las migraciones. */ }
    if (!missing.length) return true;
    if (!warned) { console.warn(JSON.stringify({ level: 'warn', message: 'Worker waiting for database migrations', pending: missing.slice(0, 5) })); warned = true; }
    if (Date.now() >= deadline) { console.error(JSON.stringify({ level: 'error', message: 'Worker started without all migrations; run npm run migrate', pending: missing.slice(0, 5) })); return false; }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};
