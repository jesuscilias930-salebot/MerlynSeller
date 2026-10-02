import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { apiOrigin, sessionPath } from './client.mjs';

// Interactive only: credentials must never appear in command arguments, logs or MCP results.
if (!process.stdin.isTTY) throw new Error('Ejecuta npm run login personalmente en una terminal interactiva.');
let muted = false;
const output = new Writable({ write(chunk, encoding, done) { if (!muted) process.stdout.write(chunk, encoding); done(); } });
const prompt = createInterface({ input: process.stdin, output, terminal: true });
try {
  const origin = apiOrigin();
  console.log(`Conectar adquisiciones a ${origin}. Se guarda solo la sesión, no la contraseña.`);
  const identifier = (await prompt.question('Usuario o correo de Control: ')).trim();
  process.stdout.write('Contraseña (oculta): '); muted = true;
  const password = await prompt.question(''); muted = false; process.stdout.write('\n');
  const response = await fetch(`${origin}/auth/login`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier, password }) });
  if (!response.ok) throw new Error('No se pudo iniciar sesión. Revisa tus credenciales de Control.');
  const body = await response.json();
  if (typeof body.token !== 'string' || !body.token) throw new Error('El backend no devolvió una sesión válida.');
  const file = sessionPath(); await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ origin, token: body.token }), { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
  console.log('Sesión guardada. Cuando expire, ejecuta este comando de nuevo. No compartas el archivo de sesión.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { muted = false; prompt.close(); }
