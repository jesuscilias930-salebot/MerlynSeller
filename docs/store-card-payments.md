# Interruptor de pagos con tarjeta

En MerlynSeller → Feature → **Tienda · Pagos con tarjeta**, un owner/admin de
`STORE_ORGANIZATION_ID` puede habilitar o deshabilitar nuevos pagos. Es independiente
de los ambientes de Stripe y Envia; no necesita nuevas claves ni variables.

## Despliegue

1. Respaldar PostgreSQL y ejecutar `npm run migrate` en salesBotBackend con las
   variables del ambiente correcto. Aplica `034_store_card_payments.sql`.
2. Desplegar/reiniciar salesBotBackend.
3. Desplegar SockControl.
4. Desplegar ecommerce y salesBotFront.

La migración deja el indicador en `true` para conservar el comportamiento actual.
Después del despliegue puede apagarse desde el CRM. No se ejecuta ninguna migración
ni se modifica la producción automáticamente al editar estos archivos.

## Contrato y seguridad

- `PUT /features`: `{ "service": "cardPayments", "enabled": false }`, con los
  permisos administrativos existentes. Se guarda por organización en PostgreSQL.
- El puente interno autenticado transmite `cardPaymentsEnabled` a SockControl.
- `GET /public/store/features` expone solo ese booleano para el tenant configurado.
- La ecommerce lo consulta sin caché vía `GET /api/store-features`, al montar el
  componente y al recuperar foco. Si falla la consulta, no muestra pago con tarjeta.
- Desactivado: desaparecen el botón de pago, su descripción y el separador “o”.
  WhatsApp es el botón principal. Acceder a `/checkout` redirige al carrito.
- Tanto `/api/orders` con `payment: stripe` como `/public/store/checkout` verifican
  la feature de nuevo. SockControl rechaza antes de guardar un pedido o contactar
  Stripe. Una pestaña antigua no permite saltarse esta validación.
- WhatsApp, los webhooks y la consulta de pagos existentes no dependen del interruptor.
- No cancela sesiones Stripe ya emitidas: quien tenga una sesión abierta todavía
  puede pagar. No se debe interpretar como cancelación o reembolso.

## Verificación manual después de desplegar

1. Desactivar en CRM; abrir/recargar el carrito y comprobar que solo aparece WhatsApp.
2. Abrir `/checkout` directamente: debe regresar a `/carrito`.
3. Concluir por WhatsApp: debe registrar el pedido y abrir el enlace con su folio.
4. Reactivar: deben reaparecer las opciones de tarjeta, conservando el modo Dev/Prod.
5. Solo en sandbox: iniciar un checkout, desactivar la feature y confirmar que el
   webhook del pago previamente iniciado continúa actualizando su pedido.

## Pruebas automatizadas

- CRM backend: `node --test tests/integration-features.test.js`.
- SockControl: `./gradlew test --tests '*StoreCardPaymentsTest' --tests '*StripePaymentServiceTest'`.
- Frontends: `./node_modules/.bin/tsc --noEmit --incremental false` en cada proyecto.
