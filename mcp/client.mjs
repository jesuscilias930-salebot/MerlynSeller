import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const sessionPath = () => process.env.MERLYN_MCP_SESSION_FILE || join(homedir(), '.config', 'merlynseller-mcp', 'session.json');
export function apiOrigin(value = process.env.MERLYN_CONTROL_URL || 'https://sock-control-api.onrender.com') {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))))
    throw new Error('Configura una URL HTTPS del backend, sin ruta ni credenciales.');
  return url.origin;
}
export function createClient({ origin = apiOrigin(), fetchImpl = fetch, loadSession = async () => {
  try { return JSON.parse(await readFile(sessionPath(), 'utf8')); }
  catch { throw new Error('Inicia sesión localmente con npm run login en salesBotBackend/mcp. No pegues contraseñas ni tokens en el chat.'); }
} } = {}) {
  return async (path, body) => {
    if (!/^\/mcp\/acquisitions(?:\?page=\d+&size=\d+|\/products\?page=\d+&size=\d+|\/\d+|\/drafts|\/drafts\/[0-9a-f-]{36}\/confirm)$/.test(path)) throw new Error('Ruta no permitida.');
    const session = await loadSession();
    if (session.origin !== origin || typeof session.token !== 'string' || !session.token) throw new Error('Sesión inválida para este backend. Inicia sesión otra vez.');
    let response;
    try {
      response = await fetchImpl(origin + path, { method: body ? 'POST' : 'GET', redirect: 'error',
        signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch {
      throw new Error('No se pudo confirmar la respuesta del backend. Si estabas confirmando una compra, reintenta SOLO el mismo draftId; no prepares otra compra hasta revisar el historial.');
    }
    if ([401,403].includes(response.status)) throw new Error('Sesión vencida o sin permiso. Inicia sesión de nuevo en el conector local.');
    if (response.status === 404) throw new Error('Recurso no encontrado. Verifica el ID y que el backend MCP esté desplegado.');
    if (!response.ok) throw new Error(`El backend rechazó la operación (HTTP ${response.status}). Revisa los datos, la migración y MCP_ACQUISITIONS_ENABLED. No se enviará de nuevo automáticamente.`);
    try { return await response.json(); } catch { throw new Error('Respuesta inválida. Revisa el historial antes de preparar otra adquisición; reutiliza el mismo draftId para confirmar.'); }
  };
}
