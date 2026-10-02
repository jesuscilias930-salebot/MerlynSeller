# MCP de adquisiciones para MerlynSeller

Conector local STDIO para Codex. No usa una API key de OpenAI, no escucha puertos
ni publica un servidor MCP en Internet. El chat permanece en Codex. Las compras
confirmadas aparecen en Control de ventas → Adquisición de mercancía del CRM.

## Preparar el backend

1. Ejecutar `sockStockControl/docs/migrations/mcp-acquisitions.sql` en MySQL.
2. Desplegar los cambios de `sockStockControl`.
3. Agregar `MCP_ACQUISITIONS_ENABLED=true` en ese servicio y reiniciarlo.
   Por defecto está deshabilitado. Los endpoints requieren el JWT de Control.

## Preparar este equipo

Requiere Node 22 o posterior. Dentro de esta carpeta:

```sh
npm ci
npm run login
```

Iniciar sesión personalmente con el usuario de Control del CRM. La contraseña
no se muestra ni guarda. La sesión queda en `~/.config/merlynseller-mcp/session.json`
con permisos 0600. No copiarla al chat, al repositorio ni a Render. Repetir login
cuando expire o revocar eliminando ese archivo concreto. No reutiliza la sesión
de OpenAI ni copia credenciales del navegador.

Opcionales: `MERLYN_CONTROL_URL` (origen HTTPS; predeterminado el sock-control de
producción) y `MERLYN_MCP_SESSION_FILE` (archivo privado fuera del repositorio).
Las sesiones están vinculadas al origen; no se reenvían a redirecciones.

Registrar el servidor en Codex con rutas absolutas:

```sh
codex mcp add merlyn-adquisiciones -- /usr/local/bin/node /Users/merlyncilias/Desktop/Apps/salesBotBackend/mcp/server.mjs
```

Reiniciar/reabrir Codex si no aparecen las herramientas. En configuración MCP,
mantener aprobación obligatoria para `confirmar_adquisicion` (approval_mode="prompt").
El argumento confirmed no sustituye la aprobación de la persona en el cliente MCP.

## Flujo

1. Listar productos y adquisiciones (páginas de hasta 50).
2. Resolver producto/categoría/género y preguntar cualquier dato faltante.
3. Preparar borrador con fecha explícita, proveedor, costos y cantidades.
4. Mostrar resumen y obtener aprobación humana.
5. Confirmar el mismo draftId. El backend bloquea el borrador en la transacción;
   las confirmaciones repetidas devuelven la misma adquisición sin aumentar stock otra vez.

Un borrador nuevo representa otra operación: NO crear otro después de un timeout
sin revisar el historial. Los borradores expiran a los 30 minutos; los confirmados
se conservan para idempotencia. No borrar sus filas como limpieza periódica.

Se registran pares para calcetines, no tripares/docenas. No se transforma IVA ni
se distribuye flete automáticamente. La marca isTaxed y costos siguen la semántica
del CRM. Registrar implica mercancía recibida y aumenta inventario inmediatamente.
No hay herramientas de eliminación, edición, SQL ni acceso genérico a APIs.

## Verificación

`npm test` usa SDK MCP y backend simulado: no genera compras reales.
Los tests Java `McpAcquisitionServiceTest` verifican aislamiento y confirmación.
Antes de usar producción verificar lectura autenticada; no crear compras de prueba.
