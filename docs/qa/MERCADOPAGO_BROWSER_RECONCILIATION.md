# Conciliación de Mercado Pago desde navegador

Base: `d0864f2`. Alcance: conciliación interna administrativa en `/dashboard/pagos`, desde Chromium hasta la aplicación compilada y PostgreSQL, con un proveedor HTTP local. La creación pública de checkout y los cobros reales quedan fuera de este recorrido.

## Defectos reproducidos

| Recorrido | Antes | Corrección |
| --- | --- | --- |
| Con teclado móvil, consultar un despacho sin ID remoto y cuya búsqueda no identifica una orden única | El botón desaparece y el campo de ID se monta sin foco. | El campo recibe el foco; cancelar o completar la identificación lo devuelve al botón de consulta. |
| Conciliar un pago completo, perder la respuesta después del commit y pulsar Actualizar conciliación | El listado muestra Liquidado junto al error del intento anterior. | El error está vinculado a la observación original y deja de mostrarse cuando el servidor entrega una nueva. |

Ambos fallos tuvieron una ejecución roja de Playwright contra el App real antes de editar el panel. Las respuestas de API y las reglas de liquidación conservan sus contratos.

## Composición y datos

`browserMercadoPagoServer.ts` arranca `dist/app` sin sustituir las rutas productivas. El transporte GET del adaptador de Mercado Pago se dirige a un servidor HTTP local que comprueba la credencial sintética de cada empresa. La fixture exige `127.0.0.1`, una base `_smoke`, un rol PostgreSQL sin superusuario ni bypass RLS, credenciales sintéticas del harness y habilitación explícita de conciliación.

`browserMercadoPago.ts` crea dos empresas mediante registro real, cifra las credenciales de sus pasarelas y prepara reservas, intenciones y despachos mediante los servicios existentes. La respuesta de creación simulada solo prepara datos; la prueba del navegador usa el JWT, la autorización, el adaptador de lectura y la persistencia reales. El comando `--inspect` comprueba directamente el estado del pedido, la conciliación y el número de acciones de liquidación dentro del scope de empresa.

El proveedor controlado permite cambiar entre pago parcial, pago completo, devolución, indisponibilidad y búsqueda sin resultado. Una interceptación Playwright pierde exclusivamente el acuse de una respuesta después de que el servidor ya la guardó.

## Casos de navegador

- En 1280 y 390 px: parcial de S/ 5,25 sobre S/ 10,50 conserva la reserva; pago completo confirma el pedido y registra una liquidación; repetir conserva una sola acción; devolución pasa a revisión sin borrar la primera fecha de liquidación. Recargar conserva el resultado y volver al pedido conserva página y conversación.
- La segunda empresa ve únicamente sus registros; intentar conciliar la intención ajena devuelve 404 y no modifica sus pedidos.
- Proveedor caído, recuperación y respuesta perdida después del commit: la consulta posterior recupera Liquidado sin error obsoleto y el reintento no duplica la liquidación.
- Despacho incierto: búsqueda sin resultado, entrada del ID con teclado móvil, cancelar y regresar, verificar el ID y persistir la observación. El foco acompaña cada cambio de control.

La devolución exige revisión operativa: el sistema conserva la liquidación histórica y no revierte automáticamente el pedido ni emite un reembolso.

## Reproducción local

Instalar y compilar primero `packages/contracts`; instalar dependencias de backend y frontend. Exportar las variables sintéticas del harness de navegador, incluida `MASTER_ENCRYPTION_KEY`, y crear/migrar una base aislada propiedad del rol de aplicación. Durante esta revisión se usó `whatsap_mercadopago_browser_smoke`.

```bash
# Entorno compartido por backend, fixture de datos y Playwright.
export DB_NAME=whatsap_mercadopago_browser_smoke
export HOST=127.0.0.1 PORT=34331
export PRODUCT_SMOKE_URL=http://127.0.0.1:34331
export PRODUCT_MERCADOPAGO_FIXTURE_URL=http://127.0.0.1:34332
export MERCADOPAGO_RECONCILIATION_ENABLED=true
export PLAYWRIGHT_PORT=4189

# Desde WhatsaapWeb-JS, mantener este servidor en ejecución.
npm run db:migrate
npm run build
node --import tsx src/test/fixtures/browserMercadoPagoServer.ts

# En otra terminal con el mismo entorno, desde Frontend_py_whatsaapweb.
npm run test:e2e -- e2e/mercadopago.integration.spec.ts
npx eslint src/factures/dashboard/components/MercadoPagoReconciliationPanel.tsx e2e/mercadopago.integration.spec.ts
npm run build
```

`MERCADOPAGO_RECONCILIATION_ENABLED` sigue deshabilitado por defecto en producción. Este procedimiento activa únicamente el proceso de prueba; no modifica `.env`, rutas ni el despliegue. La fixture rechaza arrancar si falta el valor literal `true`.

El spec requiere `PRODUCT_MERCADOPAGO_FIXTURE_URL` y ese servidor específico. CI ejecuta los cuatro casos en un paso separado, sobre una base aislada y con el flag activo únicamente durante la prueba. El paso falla si omite algún caso o el backend o el proveedor local no están disponibles.

Las trazas y capturas ante fallos se guardan en `Frontend_py_whatsaapweb/test-results`. Los JWT sintéticos se capturan internamente para autenticar el navegador; no se imprimen en logs de prueba.

## Resultado local

- Chromium: **4/4**, sin omitidos, **14,3 s** en la ejecución final.
- Contratos HTTP y PostgreSQL: **11/11**, sin omitidos, mediante `node --import tsx --test src/test/payment-checkout-reconciliation-routes.test.ts src/test/payment-checkout-reconciliation-postgres.test.ts`, con `PAYMENT_CHECKOUT_TEST_DATABASE_URL` apuntando a la base sintética.
- Adaptador Orders: **9/9** mediante `node --import tsx --test src/test/mercado-pago-orders-adapter.test.ts`.
- Compilación de contratos, backend y frontend; TypeScript estricto de ambas fixtures; ESLint del panel y spec; `git diff --check`: correctos.
- Revisión independiente del diff sin bloqueantes. Inspección visual de la vista móvil sin desbordamiento horizontal; el spec también lo verifica en ambos tamaños.
