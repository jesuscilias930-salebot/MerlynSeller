# Escenarios desde Codex

Este conector interpreta el prompt en Codex y guarda pasos compatibles con el constructor actual. No instala una IA autónoma en los chats ni requiere una clave de OpenAI. El CRM sigue comparando ejemplos y reglas. No se ejecutan mensajes durante la validación.

## Despliegue y conexión

1. Desplegar salesBotBackend y ejecutar `npm run migrate` allí (PostgreSQL del CRM, NO MySQL de sock-control). Incluye `036_scenario_mcp_sessions.sql`. No ejecutar contra otra base.
2. Desplegar salesBotFront. Entrar como propietario/administrador en MerlynSeller → Escenarios → Conectar con Codex y generar/copiar código.
3. En una terminal local: `cd /Users/merlyncilias/Desktop/Apps/salesBotBackend/mcp` y `npm run login:scenarios`. Pegar el código cuando lo solicite; nunca en el chat ni como argumento.
4. El backend por defecto es `https://merlynseller.onrender.com`. Si se usa otro, definir `MERLYN_CRM_URL` tanto al registrar el MCP como al iniciar sesión. Instalar dependencias con `npm ci` dentro de mcp si faltan.
5. Registrar si aún no existe: `codex mcp add merlyn-escenarios -- /usr/local/bin/node /Users/merlyncilias/Desktop/Apps/salesBotBackend/mcp/scenario-server.mjs`. Configurar aprobación por herramienta para `guardar_escenario` en modo `prompt`. Reiniciar Codex.

El acceso vence en 7 días y se puede revocar en el CRM. Regenerar invalida el código anterior. Solo se guarda el hash en PostgreSQL; la sesión local está fuera del repositorio con permisos 0600. No usar el token general de adquisiciones.

## Uso

Ejemplo: «Crea un escenario apagado para quienes piden catálogo. Envía el catálogo que ya está cargado, pregunta si compra para revender, espera su respuesta y mueve el lead a la columna existente que te indique».

Codex consulta escenarios/recursos, presenta el flujo, valida y guarda. Los nuevos quedan apagados por defecto. Para activar respuestas futuras se requiere autorización explícita. Recargar Escenarios para ver el resultado. Admitidos: texto, catálogo, fotos/documentos existentes, esperar respuesta con ramas, recomendaciones por presupuesto, mover columna y finalizar. Consultar datos faltantes en lugar de inventarlos.

Las ediciones usan una revisión para no sobrescribir cambios recientes del editor. Si la red falla, consultar el escenario y reutilizar su UUID; no crear uno nuevo a ciegas. No se incluyen herramientas para eliminar escenarios ni mandar mensajes directamente.

Validación: `node --test tests/scenario-mcp.test.js` desde backend y `npm test` desde mcp. Las pruebas usan recursos simulados y no acceden a producción.
