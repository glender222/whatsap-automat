# UX-15: fechas coherentes en mensajes en vivo e historial

## Defecto reproducido

El 11 de noviembre de 2026, Chromium mostró un mensaje entrante en el año 58831. El mismo hilo mostraba correctamente en 2026 el mensaje saliente cargado por HTTP.

La reproducción usa el webhook Meta firmado, PostgreSQL y Socket.IO reales del backend local, con dos empresas y proveedores sintéticos. El mensaje entrante tiene un timestamp Unix en segundos. Tanto el evento `message` como `GET /api/chats/:chatId/messages` conservan esos segundos; `GET /api/v1/conversations/:id/messages` usa `createdAt` ISO. El fixture también envía segundos. No se encontró doble conversión en el backend.

`useSocketSimple` normaliza el evento a milisegundos. `MessagesPanel` ya normalizaba segundos/milisegundos para ordenar su timeline, pero al mostrar la fecha volvía a multiplicar el valor original por 1000. Por eso el error aparecía en vivo y desaparecía al recuperar ese mensaje desde HTTP.

La primera ejecución de la regresión falló esperando `10/11/2026, 8:31:02 p. m.` y observando `10/1/58831, 12:13:20 a. m.` en el mismo mensaje de Alfa. La zona de la prueba es `America/Lima`; no se comparan únicamente años ni valores internos.

## Corrección y compatibilidad

El timeline usa el normalizador compartido y el render utiliza directamente el timestamp normalizado de ese timeline. Se conserva el formato local del navegador y los contratos HTTP, Socket, persistencia y agentes existentes. No hay migración de datos.

El barrido encontró conversiones similares en `MessagesPanelLoader` y `formatMessageTime`, sin consumidores en el árbol actual de `src`. No se modifican esas rutas sin uso; si se reactivan, deben adoptar el mismo contrato y una prueba de su recorrido.

## Regresión verificable

`Frontend_py_whatsaapweb/e2e/inbox-timestamps.integration.spec.ts` verifica en Chromium, a 1280 y 390 píxeles:

1. La fecha completa del saliente inicial cargado por HTTP.
2. Los segundos exactos del evento Socket real y la fecha completa del mensaje entrante renderizado.
3. El orden de los mensajes y el aislamiento entre Alfa y Bravo.
4. La misma fecha después de recargar desde el historial HTTP.
5. Compatibilidad al releer un historial que ya contiene milisegundos, transformando sólo la respuesta HTTP del fixture.

Con el entorno sintético de `product-smoke` exportado, base local independiente terminada en `_smoke`, migraciones aplicadas y backend local listo en `PRODUCT_SMOKE_URL`, ejecutar desde `Frontend_py_whatsaapweb`:

```bash
npm run test:e2e -- e2e/inbox-timestamps.integration.spec.ts
npm run test:canonical-inbox
npm run build
```

Resultado local: 2/2 escenarios Chromium; 9/9 pruebas de contratos de bandeja; compilación TypeScript/Vite correcta. Las pruebas de navegador usan la bandeja activa y no requieren proveedores reales.
