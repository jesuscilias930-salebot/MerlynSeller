import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { scenarioOrigin, scenarioSessionPath, createScenarioClient } from './scenario-client.mjs';

if (!process.stdin.isTTY) throw new Error('Ejecuta npm run login:scenarios en una terminal interactiva.');
let muted = false;
const output = new Writable({ write(chunk, encoding, done) { if (!muted) process.stdout.write(chunk, encoding); done(); } });
const prompt = createInterface({ input: process.stdin, output, terminal: true });
try {
  const origin = scenarioOrigin();
  console.log(`Conectar Escenarios a ${origin}. Genera y copia el código en MerlynSeller → Escenarios → Conectar con Codex.`);
  process.stdout.write('Código (oculto): '); muted = true;
  const token = (await prompt.question('')).trim(); muted = false; process.stdout.write('\n');
  await createScenarioClient({ origin, loadSession: async () => ({ origin, token }) })('/mcp/scenarios');
  const file = scenarioSessionPath(); await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ origin, token }), { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
  console.log('Conectado por 7 días. Puedes revocar el acceso desde Escenarios. No compartas el archivo de sesión.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { muted = false; prompt.close(); }
