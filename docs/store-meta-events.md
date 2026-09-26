# Tienda · Eventos de Meta

Control global en MerlynSeller → Feature → **Tienda · Eventos de Meta**.
Solo owner/admin de STORE_ORGANIZATION_ID puede modificarlo mediante PUT /features
con `{ "service": "metaEvents", "enabled": true }` (o false).
No requiere claves nuevas: usa el puente autenticado de features existente.

## Despliegue

1. Ejecutar `db/migrations/035_store_meta_events.sql` en PostgreSQL de salesBotBackend.
   Es idempotente. Agrega meta_events_enabled con default false.
   El runner `npm run migrate` aplica todas las migraciones pendientes: revisarlas antes.
2. Desplegar salesBotBackend, después sockStockControl, después ecommerce y salesBotFront.
3. Entrar como administrador y comprobar el switch. Por defecto queda Off.
4. Para medir visitantes reales, poner On; además siguen siendo necesarias las claves de Meta y el consentimiento publicitario.

Off bloquea el píxel y las conversiones de **todos** los clientes, no solo del administrador.
La tienda consulta al navegar, al recuperar foco y cada 15 segundos (más latencia de red).
Recargar la tienda antes de probar. Si el puente falla, se desactiva el envío.
Una solicitud a Meta ya en vuelo o un evento ya enviado no puede retirarse con este switch.

SockControl aplica el ajuste al crear pedidos, al confirmar pagos y antes de enviar conversiones.
Pedidos creados o pagados con Meta apagado quedan sin atribución, también después de reactivarlo.
Las conversiones en cola que el proceso encuentra estando apagado se descartan, no se recuperan al encender.
Los pagos y webhooks siguen funcionando: Off no activa sandbox ni impide cobros reales.
No se modifica la configuración de Stripe/Envia ni los consentimientos del navegador.

Reemplaza completamente `meta_test`: el parámetro y la cookie anteriores ya no controlan Meta.
No hay migración MySQL ni nuevas variables de entorno en esta tarea.
