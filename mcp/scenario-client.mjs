import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { apiOrigin } from './client.mjs';

export const scenarioOrigin = () => apiOrigin(process.env.MERLYN_CRM_URL || 'https://merlynseller.onrender.com');
export const scenarioSessionPath = () => process.env.MERLYN_SCENARIO_SESSION_FILE || join(homedir(), '.config', 'merlynseller-mcp', 'scenarios.json');
export function createScenarioClient({ origin = scenarioOrigin(), fetchImpl = fetch, loadSession = async () => {
  try { return JSON.parse(await readFile(scenarioSessionPath(), 'utf8')); }
  catch { throw new Error('Conecta Escenarios en MerlynSeller y ejecuta npm run login:scenarios. No pegues códigos en el chat.'); }
} } = {}) {
  return async (path, body) => {
    if (!['/mcp/scenarios','/mcp/scenarios/context','/mcp/scenarios/validate','/mcp/scenarios/definition'].includes(path)) throw new Error('Ruta no permitida.');
    const session = await loadSession();
    if (session.origin !== origin || !/^[A-Za-z0-9_-]{43}$/.test(session.token || '')) throw new Error('Sesión inválida para este backend. Conecta de nuevo.');
    let response;
    try {
      response = await fetchImpl(origin + path, { method: path.endsWith('/definition') ? 'PUT' : body ? 'POST' : 'GET',
        redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new Error('Respuesta no confirmada. Consulta los escenarios antes de reintentar y reutiliza el mismo ID; no crees otro.'); }
    const result = await response.json().catch(() => null);
    if ([401,403].includes(response.status)) throw new Error('Conexión vencida o revocada. Genera un código nuevo en Escenarios.');
    if (!response.ok) throw new Error([400,404,409].includes(response.status) && result?.error || `Operación rechazada (HTTP ${response.status}).`);
    if (result === null) throw new Error('Respuesta inválida. Consulta los escenarios antes de reintentar.');
    return result;
  };
}
