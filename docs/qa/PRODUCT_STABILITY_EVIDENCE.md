# Evidencia de estabilidad del producto

Este registro separa los recorridos verificados y los pendientes. Para cerrar un defecto se registra la reproducción, el cambio y el resultado de la regresión. Cuando el recorrido cruza empresas, la evidencia identifica los roles y la separación comprobada.

## UX-01. El tema cambia al navegar

- **Antes.** Chromium abrió la bandeja con el sistema en Claro y la preferencia Oscuro guardada. La barra de navegación ya era visible y el documento seguía sin la clase `dark`. La prueba falló en esa aserción sobre la base `6f064ea`.
- **Causa.** El módulo de Configuración aplicaba el tema al importarse. El átomo se inicializaba con una preferencia capturada al cargar el módulo y el selector volvía a escribirla al montarse. Al cambiar la sesión se recreaba el almacén.
- **Cambio.** El documento aplica el tema antes de cargar React. El estado de apariencia se mantiene a nivel del navegador. Los cambios de sesión siguen recreando el estado de datos de la aplicación. Configuración usa un selector nativo y el selector de emojis consume el tema efectivo.
- **Después.** Tres pruebas en Chrome comprobaron el arranque antes de React, el recorrido Bandeja → Configuración → Bandeja, el cambio de sesión, la recarga, el cambio de tema del sistema y la sincronización entre pestañas. La suite del frontend pasó 72 pruebas y el build terminó correctamente.

Reproducción desde `Frontend_py_whatsaapweb`:

```sh
npm ci
npx playwright install chromium
npm run test:e2e -- e2e/theme.spec.ts
```

Para usar Chrome instalado en el sistema se puede ejecutar `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e -- e2e/theme.spec.ts`. Las pruebas de apariencia usan respuestas HTTP de prueba y dos sesiones de navegador.

## MSG-01. Conversaciones nuevas y recuperación de la bandeja

- **Antes.** Chrome abrió dos bandejas vacías conectadas por Socket.IO. El backend confirmó los webhooks firmados y el historial HTTP devolvió el texto correcto por empresa. La prueba falló porque el mensaje nuevo de Alfa seguía ausente de su bandeja.
- **Cambio.** Socket.IO actualiza las filas existentes. Cuando llega un mensaje de una conversación ausente, la bandeja consulta el filtro activo por HTTP. Al conectar de nuevo, también consulta el historial seleccionado.
- **Después.** La prueba pasó con backend compilado y PostgreSQL con RLS. Alfa y Bravo recibieron mensajes diferentes con el mismo contacto e identificador del proveedor. Cada bandeja mostró su propio texto. Al cortar la conexión de Alfa, otro mensaje quedó guardado y apareció al reconectar mediante una recarga automática del historial. Bravo no lo vio.

La prueba utiliza un backend local con la configuración sintética del job `product-smoke` en [CI](../../.github/workflows/ci.yml). Se requiere PostgreSQL en `127.0.0.1`, una base separada con nombre terminado en `_smoke`, las migraciones aplicadas y el token de fixture `synthetic-local-token`. Con las variables del backend exportadas y `PRODUCT_SMOKE_URL` apuntando a ese servidor, ejecutar desde `Frontend_py_whatsaapweb`:

```sh
npm run test:e2e -- e2e/inbox.integration.spec.ts
```

Las pruebas de Studio y despacho acotado pasaron 18 casos con PostgreSQL y un proveedor local de prueba. Confirman el aislamiento de revisiones y las cuotas, además de que la ruta de publicación actual devuelve `501`.

## MSG-02. Recibo de entrega antes del acuse de envío

- **Antes.** Graph local registró un recibo de entrega antes de responder al envío de una plantilla. El backend conservó el evento, pero el mensaje terminó como `sent` y sin una entrega en el historial.
- **Cambio.** El webhook y la persistencia del envío comparten el bloqueo por empresa e identificador de Meta. Cuando se guarda el envío se aplican los recibos previos que coinciden con su línea y destinatario. Los recibos de campañas y envíos canónicos conservan su reconciliación específica.
- **Después.** PostgreSQL registró la plantilla como `delivered` y una sola entrada de entrega tras duplicar el evento. Los recibos de lectura de otra línea o destinatario no modificaron la plantilla, incluso al llegar después del acuse. Pasaron los 20 casos de las suites `legacy-meta-send-postgres`, `conversation-send-postgres` y `meta-webhook-p0` con Graph local y FFmpeg.

## MSG-03. Entrega en el historial abierto y llegada simultánea de mensajes

- **Antes.** En Chromium, el historial HTTP devolvía `delivered` tras recibir el webhook firmado, pero la conversación abierta no mostraba «Entregado». Al añadir la actualización en vivo, una segunda reproducción mostró que una respuesta HTTP anterior podía quitar del historial un mensaje recibido por Socket.IO en el mismo segundo.
- **Cambio.** Tras confirmar un avance de estado en PostgreSQL, el backend avisa únicamente a la sala de la empresa y conversación. La bandeja actualiza el historial sin ocultarlo. La reconciliación conserva las llegadas recibidas mientras esa petición estaba pendiente, aunque compartan la marca de tiempo de un mensaje de la respuesta HTTP.
- **Después.** En dos empresas con el mismo contacto e identificador de proveedor, Alfa pasó de «Enviado» a «Entregado» y «Leído». Bravo conservó «Enviado» y recibió cero avisos de Alfa. Se verificó que «Leído» no retrocede ante un recibo tardío y que el mensaje simultáneo permanece en el historial después de completar la petición retrasada.

## IA-01. Evaluación de ejecución por revisión y empresa

- El evaluador interno carga una revisión inmutable y una suite guardada bajo RLS. Verifica las afirmaciones y el presupuesto del conjunto antes de llamar al proveedor. La ejecución reclama un UUID persistido y guarda las huellas de la revisión y de la suite, los resultados de las afirmaciones y las referencias de consumo. El resumen omite el texto de entrada y salida.
- La prueba de `bounded-agent-dispatch.test.ts` ejecutó el perfil de texto con un proveedor HTTP de loopback y PostgreSQL. Alfa aprobó su suite y Bravo rechazó una respuesta que incumplía su afirmación. Bravo no pudo leer ni reutilizar el UUID de Alfa. Un reintento concurrente o posterior mantuvo el número de llamadas. Una suite inválida o fuera del presupuesto no despachó nada. Un fallo incierto terminó la evaluación y el reintento no repitió el consumo.
- El servicio cubre el perfil de texto acotado. Para usar el resultado como evidencia de publicación faltan la admisión de cuota en producción, una ruta autorizada y el vínculo entre la evaluación vigente y la revisión activa.

Para reproducirlo, aplicar la migración 056 en la base local de pruebas y ejecutar `node --import tsx --test src/test/bounded-agent-dispatch.test.ts` desde el backend con `AI_QUOTA_RESERVATIONS_TEST_DATABASE_URL` apuntando a esa base.

## WF-01. Ingreso mientras se revierte una revisión publicada

- **Antes.** CI devolvió `WORKFLOW_NOT_PUBLISHED` durante una reversión válida. La regresión local mantuvo la reversión abierta hasta observar en PostgreSQL que un webhook esperaba su bloqueo. El ingreso falló al intentar fijar la revisión mediante una consulta que también bloqueaba la definición.
- **Después.** El ingreso bloquea la definición primero y lee la revisión publicada en una consulta posterior. La prueba con Temporal y PostgreSQL aceptó 40 webhooks durante la reversión y los fijó a la revisión restaurada. La ejecución previa conservó su revisión original y siguió inaccesible para la otra empresa.

## Recorridos por cerrar

| Recorrido | Evidencia pendiente |
| --- | --- |
| Bandeja en tiempo real | Filtro por etiqueta. Extender la evidencia de navegador de MSG-01 y MSG-03. |
| Envío y recepción | Extender los casos de reorden y duplicados ya probados a la bandeja. Verificar timeout, reintento, historial paginado, adjuntos, ventana de atención y toma de control. Contar las llamadas al proveedor de prueba y comprobar persistencia e identidad. |
| Harness IA | Borrador, validación, evaluación de ejecución, publicación y ejecución de una revisión inmutable. Comprobar permisos, límites, cancelación, recuperación y efectos concurrentes. |
| Flujo operativo y navegación | Atención, pedido, pago, aprobación y conexión. Recorrer como administrador y operador, con teclado y diferentes tamaños de pantalla. |
