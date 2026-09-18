# Feature: ambientes de Envia y Stripe

La sección **Feature** del CRM es visible para owner/admin. Solo permite operar la organización `STORE_ORGANIZATION_ID`. Cada integración cambia por separado y se guarda en PostgreSQL. No cambia servidores, usuarios, inventario ni bases de datos.

## Configuración (sin compartir claves en el chat)

En **salesBotBackend**, configura secretos privados del servidor:

```dotenv
ENVIA_TOKEN_SANDBOX=<token del portal de pruebas>
ENVIA_TOKEN_PRODUCTION=<token del portal de producción>
SOCK_CONTROL_URL=http://localhost:8080
STORE_ORGANIZATION_ID=<UUID de la organización CRM de la tienda>
STORE_SHIPPING_SECRET=<secreto interno aleatorio de al menos 32 caracteres>
```

En **SockControl**, configura variables del servidor:

```dotenv
STRIPE_ENABLED=true
STRIPE_TEST_API_KEY=<clave restringida rk_test_ con permisos de Checkout>
STRIPE_LIVE_API_KEY=<clave restringida rk_live_ con permisos de Checkout>
STRIPE_TEST_WEBHOOK_SECRET=<whsec_ de prueba>
STRIPE_LIVE_WEBHOOK_SECRET=<whsec_ del endpoint de producción>
STRIPE_STOREFRONT_URL=https://tu-tienda.example
STORE_SHIPPING_CRM_URL=http://localhost:3005
STORE_SHIPPING_SECRET=<mismo secreto interno del CRM>
STORE_FEATURE_TENANT=tienda-local
```

Los valores entre `<...>` son marcadores, no claves válidas. Usa el tenant real en despliegues; debe coincidir con el que envía la tienda. En local la URL de retorno puede ser `http://localhost:3000`, pero eso bloquea producción deliberadamente. En Render usa URLs HTTPS para ambos backends y la tienda.

Las claves nunca van en `NEXT_PUBLIC_*`, ni en el frontend, ni en Git. Usa el almacén de secretos de tu plataforma; si no dispone de uno, variables privadas del servidor. Hosted Checkout no necesita una clave publicable en este flujo. Se admiten también `sk_test_`/`sk_live_`, pero se recomienda una clave restringida con los permisos mínimos necesarios.

Compatibilidad: `ENVIA_TOKEN` es respaldo **solo de pruebas**; `stripe.api-key`/`STRIPE_API_KEY` y `stripe.webhook-secret`/`STRIPE_WEBHOOK_SECRET` son respaldo **solo de pruebas**. Una clave antigua de producción de Envia debe moverse a `ENVIA_TOKEN_PRODUCTION`; nunca se utiliza automáticamente como clave live.

## Instalación y reinicio

1. Respaldar las bases antes del despliegue.
2. En salesBotBackend ejecutar `npm run migrate` contra la base correcta. Agrega `033_integration_features.sql` (no borra datos). Inicialmente ambos ambientes son sandbox, incluso si los formularios antiguos indicaban producción.
3. En SockControl agregar la columna nullable `pending_orders.stripe_environment`. Con `ddl-auto=update` ocurre al reiniciar; si utilizas `validate` o migraciones manuales, ejecutar una vez `docs/migrations/stripe-environment.sql`. No ejecutar el ALTER si la columna ya existe.
4. Configurar las variables y reiniciar salesBotBackend y SockControl. Desplegar también salesBotFront y ecommerce: el código anterior de la tienda solo aceptaba sesiones de prueba.
5. Abrir **Feature → Actualizar estado**. “Credenciales configuradas” verifica presencia/formato, habilitación y URL, **no** prueba permisos o autenticidad ante Stripe/Envia.
6. Validar en pruebas un pedido completo, tarifa, pago y webhook. No se hacen cobros al cambiar el switch.
7. Registrar en Stripe el webhook **live** `https://tu-sockcontrol/stripe/webhook`, copiar su secreto live y habilitar `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired` con versión compatible con el SDK. El secreto del CLI local no es el secreto live.
8. Para producción elegir primero Envia producción y después Stripe producción, confirmando cada cambio. Volver a cotizar carritos abiertos: un cobro live rechaza tarifas sandbox.

## Comportamiento

- Envia utiliza el ambiente de Feature para cotizaciones y generación **manual** de guías del CRM. Cotizar y pagar no generan guías.
- Cambiar Stripe afecta nuevos intentos. Cada pedido conserva su ambiente antes de contactar a Stripe; reintentos reutilizan la misma sesión e idempotencia.
- Los webhooks siguen aceptando firmas válidas de ambos ambientes, independientemente del switch. Mantén ambos secretos mientras existan pagos pendientes.
- Los pagos reales se marcan `PAID`; los de prueba `PAID_TEST`. Los pedidos antiguos sin columna de ambiente se tratan como prueba.
- Si el CRM no responde o el tenant no coincide, no se inicia un pago nuevo. No se hace fallback silencioso a otro ambiente.
- Este cambio no agrega reserva/descuento automático de inventario, reembolsos ni conciliación. Revisa estos procesos antes de tu lanzamiento.
