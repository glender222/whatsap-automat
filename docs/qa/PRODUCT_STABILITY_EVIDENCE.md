# Evidencia de estabilidad del producto

Este registro separa los recorridos verificados y los pendientes. Para cerrar un defecto se registra la reproducción, el cambio y el resultado de la regresión. Cuando el recorrido cruza empresas, la evidencia identifica los roles y la separación comprobada.

El job `product-smoke` ejecuta la prueba de sesión Socket.IO y la suite de Chromium con una base independiente, migraciones desde cero y proveedores locales para Graph y Studio. El paso del navegador falla si se omite un recorrido y conserva el informe y las trazas cuando hay fallos. La ejecución local del paso con Chromium de Playwright pasó los 13 recorridos sin omisiones. La suite de sesión pasó 9 pruebas. [Workflow de CI](../../.github/workflows/ci.yml).

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

## UX-02. El regreso desde un pedido pierde la página

- **Antes.** En escritorio como administrador y en móvil como operador, abrir un pedido de la segunda página y usar «Volver a pedidos» llevaba a la primera página y volvía a consultar el offset 0.
- **Después.** El detalle lleva la página de origen en su URL. Chrome volvió a consultar el offset 20 y mostró el mismo pedido tras recargar el detalle. Ambos recorridos se hicieron con teclado. Escape cerró el diálogo de confirmación, devolvió el foco al botón y no envió una mutación.

## UX-03. Pagos conserva superficies claras con el tema Oscuro

- **Antes.** Al entrar desde Bandeja, el documento seguía en Oscuro pero Chrome calculaba un fondo blanco para Comprobantes manuales. Pagos y la conciliación usaban colores fijos.
- **Después.** Las superficies, los textos y los controles de Pagos y conciliación usan los tokens de apariencia del espacio de trabajo. Chrome verificó el fondo de ambos paneles y del filtro de conciliación, además del color del título, al navegar con Oscuro y luego con Claro. La prueba usa respuestas HTTP de fixture y no consulta ni concilia pagos reales.

Para reproducir UX-02 y UX-03, ejecutar `npm run test:e2e -- e2e/orders-navigation.spec.ts e2e/theme.spec.ts` desde el frontend.

## UX-04. Una respuesta tardía cambia los resultados del filtro de pagos

- **Antes.** Chrome recibió la respuesta de «Validados» y después la de «Con voucher». El filtro «Validados» seguía marcado, pero la tabla pasó a mostrar el comprobante pendiente.
- **Después.** Cambiar el filtro cancela la consulta anterior. La tabla y el contador solo usan el resultado asociado a la consulta vigente. Si falla, «Volver a cargar pagos» repite el filtro activo. La regresión en `e2e/payment-filters.spec.ts` reproduce el orden invertido y comprueba la recuperación de un `503`.

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

## MSG-04. Filtro de etiquetas y webhooks fuera de orden

- **Antes.** En el filtro «Soporte», una respuesta HTTP retenida reemplazaba una vista previa que Socket.IO acababa de actualizar en el mismo segundo. Una prueba independiente contra PostgreSQL mostró que un mensaje llegado 25 horas tarde también reemplazaba la vista previa persistida.
- **Cambio.** HTTP determina qué filas pertenecen al filtro. Si devuelve la misma fila que había al iniciar la consulta, la bandeja conserva la actualización que llegó en el intervalo. La persistencia conserva la fecha más reciente del cliente y su ventana de atención. Un mensaje más antiguo se incorpora al historial y al contador de no leídos sin reemplazar la vista previa del mensaje más reciente.
- **Después.** Chrome mantuvo «Soporte» al reconectar Alfa, mostró el mensaje recibido sin conexión y ocultó la conversación sin etiqueta. La consulta del identificador de la etiqueta de Alfa devolvió `404` para Bravo. El mensaje tardío y su duplicado dejaron cuatro no leídos en Alfa y uno en Bravo. PostgreSQL confirmó dos mensajes únicos en el historial de la prueba aislada, la vista previa reciente y la ventana activa.

Para reproducirlo con el entorno de MSG-01, ejecutar `npm run test:e2e -- e2e/inbox.integration.spec.ts -g 'active tag'`. La prueba SQL está incluida en `legacy-meta-send-postgres.test.ts`.

## MSG-05. Historial con más de una página

- **Antes.** Con 52 mensajes persistidos en un solo segundo, la primera consulta devolvía 50. Usar la fecha de su primer mensaje como límite devolvía cero, aunque quedaban dos mensajes.
- **Cambio.** El historial de Meta admite `nextCursor` y `cursor` en `/api/chats/:chatId/messages`. PostgreSQL ordena por fecha e identificador y verifica que el ancla pertenezca a la conversación y empresa autenticadas. Se admiten de 1 a 200 mensajes por página. Las consultas existentes con `before` conservan la respuesta por fecha y el proveedor WebJS sigue usando su ruta habitual.
- **Después.** Dos empresas con los mismos identificadores de proveedor y el mismo segundo recuperaron los 52 mensajes de su propia conversación, en escritorio y móvil. El cursor de Alfa devolvió una página vacía en Bravo. En Alfa, un `503` en la página anterior mostró un reintento y conservó los 50 mensajes. Al recuperar la página, la primera fila visible conservó posición y foco. Tras un mensaje en vivo y otro recibido sin conexión, el historial conservó las páginas cargadas al reconectarse.
- Si la página más reciente tras la reconexión carece de mensajes en común con la última página recibida, el historial vuelve a paginar desde el resultado reciente para que el tramo intermedio sea accesible.
- Al simular en el navegador la asignación tardía del identificador de WhatsApp, el primer intento mostraba 55 filas para 54 mensajes. El historial ahora reconcilia por `historyId` cuando el identificador externo cambia. PostgreSQL confirmó que la misma fila conserva `historyId` antes y después de asignar el identificador del proveedor.

Para reproducirlo, usar el entorno de MSG-01 y ejecutar `npm run test:e2e -- e2e/inbox.integration.spec.ts -g 'history loads messages'`. `legacy-meta-send-postgres.test.ts` cubre también tres páginas consecutivas, el cursor de otra conversación y la consulta anterior por fecha.

## MSG-06. Toma de control, reintento, adjunto y entrega incierta

- **Antes.** En Chrome, tras la pérdida de respuesta del proveedor, un recibo firmado cambió el historial a «Entregado». El cuadro de respuesta siguió bloqueado y conservó el texto enviado hasta pulsar «Actualizar estado».
- **Cambio.** Una notificación de entrega del hilo activo vuelve a comprobar el intento si hay un resultado pendiente. Al reconectar se actualizan la bandeja, el historial y el estado canónico de la conversación. La confirmación solo limpia el borrador que coincide con el envío y conserva cualquier edición posterior.
- **Después.** El operador de Alfa tomó el control con teclado y el foco pasó al cuadro de respuesta. Bravo, con el mismo contacto y una ventana vencida, conservó su borrador y no pudo enviar ni adjuntar. Un timeout en el navegador anterior al despacho permitió repetir la misma clave y generó un solo POST de texto a Graph. Un rechazo de subida dejó disponible el archivo original. El reintento subió el archivo y lo envió una vez. Alfa descargó los bytes por las rutas actual y de compatibilidad. La solicitud sin sesión devolvió `401` y Bravo no pudo acceder al archivo.
- Dos pérdidas de respuesta de Graph dejaron sendos envíos pendientes. Un recibo firmado para la línea de Bravo no resolvió el intento de Alfa. El recibo correcto desbloqueó la respuesta en vivo y, en el segundo caso, al reconectar. El historial mostró cada envío una vez y el borrador editado se conservó. Graph registró dos subidas y cuatro POST de envío en Alfa, y cero en Bravo. El recuento excluye los acuses de lectura.

Para reproducirlo, usar la base local de MSG-01 y arrancar el backend desde `WhatsaapWeb-JS` con el proveedor simulado:

```sh
npm run build
export HOST=127.0.0.1 PORT=34254
export PRODUCT_SMOKE_URL=http://127.0.0.1:34254
export PRODUCT_GRAPH_FIXTURE_URL=http://127.0.0.1:34255
node --import ./src/test/fixtures/browserGraph.mjs dist/index.js
```

Desde el frontend, con las mismas variables de prueba exportadas, ejecutar `npm run test:e2e -- e2e/inbox.integration.spec.ts -g 'composer scopes'`. La carga previa solo admite direcciones de loopback, una base terminada en `_smoke` y el token sintético. Reenvía las peticiones del adaptador Graph al proveedor local.

## IA-01. Evaluación de ejecución por revisión y empresa

- El evaluador interno carga una revisión inmutable y una suite guardada bajo RLS. Verifica las afirmaciones y el presupuesto del conjunto antes de llamar al proveedor. La ejecución reclama un UUID persistido y guarda las huellas de la revisión y de la suite, los resultados de las afirmaciones y las referencias de consumo. El resumen omite el texto de entrada y salida.
- La prueba de `bounded-agent-dispatch.test.ts` ejecutó el perfil de texto con un proveedor HTTP de loopback y PostgreSQL. Alfa aprobó su suite y Bravo rechazó una respuesta que incumplía su afirmación. Bravo no pudo leer ni reutilizar el UUID de Alfa. Un reintento concurrente o posterior mantuvo el número de llamadas. Una suite inválida o fuera del presupuesto no despachó nada. Un fallo incierto terminó la evaluación y el reintento no repitió el consumo.
- El servicio cubre el perfil de texto acotado. IA-02 verifica el uso de la evidencia en la publicación interna. La admisión de cuota de producción y la ruta autorizada quedan pendientes.

Para reproducirlo, aplicar la migración 056 en la base local de pruebas y ejecutar `node --import tsx --test src/test/bounded-agent-dispatch.test.ts` desde el backend con `AI_QUOTA_RESERVATIONS_TEST_DATABASE_URL` apuntando a esa base.

## IA-02. Publicación y ejecución de una revisión evaluada

- **Publicación.** El servicio interno requiere una evaluación completada de la misma empresa, revisión y modo. Comprueba la huella actual de la suite y las reservas liquidadas de cada escenario. En PostgreSQL rechazó evidencia de otra empresa, de una suite editada, de una ejecución fallida y de un informe copiado a otro UUID. Dos publicaciones simultáneas de la misma revisión devolvieron el mismo registro.
- **Ejecución.** Tras guardar la revisión 2 como borrador, el servicio ejecutó la revisión 1 publicada y registró el consumo como `completion`. Otra empresa no pudo ejecutar esa revisión y el proveedor local no recibió una llamada adicional. El modo de verificación tampoco activó una revisión para el modo de proveedor.
- **Verificación.** Se aplicó la migración 057 en la misma base de pruebas de IA-01. Pasaron 38 casos en `bounded-agent-dispatch`, `agent-studio-postgres`, `agent-eval-simulator` y `publication-gate`. IA-03 conecta esa evidencia con HTTP y la interfaz en una composición explícita de verificación.

## IA-03. Recorrido de Studio desde la interfaz

- El backend admite una composición explícita de verificación. Todas sus rutas requieren administrador y una revisión guardada explícita. Las suites guardadas y los UUID de evaluación se reutilizan en los reintentos. El servidor comprueba la pertenencia, el contenido y la evidencia antes de publicar, y ejecuta únicamente la revisión activa seleccionada.
- La configuración habitual de la aplicación devuelve `mode: null` y mantiene la ejecución y publicación indisponibles. La composición de verificación conserva su propio modo en PostgreSQL. Las pruebas confirman que esas publicaciones no habilitan el modo de proveedor.
- En Chrome, Alfa y Bravo crearon el mismo identificador de grafo en sus empresas. Alfa guardó y aprobó dos escenarios. Bravo guardó un escenario fallido y su botón de publicación quedó deshabilitado. Bravo obtuvo `404` al consultar el UUID de Alfa. Tras recargar, Alfa recuperó su evaluación, publicó la revisión 1 y la ejecutó. Guardar una revisión 2 conservó la revisión 1 activa y la pantalla dejó de ofrecer la ejecución desde el borrador 2.
- La suite conjunta pasó 13 recorridos de Chrome con las simulaciones locales de IA y Graph en el mismo backend. Pasaron también 38 pruebas de backend de Studio y 72 del frontend, además de los builds y la comprobación de tipos.

Para reproducir el recorrido con la base local y las migraciones de IA-02, ejecutar desde el backend:

```sh
export HOST=127.0.0.1 PORT=34256
export PRODUCT_SMOKE_URL=http://127.0.0.1:34256
export STUDIO_FIXTURE_URL=http://127.0.0.1:34257
node --import tsx src/test/fixtures/browserStudio.ts
```

Con las mismas variables exportadas en el frontend, ejecutar `npm run test:e2e -- e2e/agent-studio.integration.spec.ts`. El proveedor HTTP local devuelve el perfil acotado con uso verificado de prueba y el estado persiste bajo RLS.

## IA-04. Cancelación y recuperación de resultados parciales

- **Antes.** La regresión contra PostgreSQL encontró cero resultados al consultar la evaluación mientras corría el segundo caso, aunque el primero ya había terminado.
- **Cambio.** Studio persiste cada resultado antes de admitir el siguiente. La cancelación y la admisión se coordinan en la misma fila. El caso admitido puede registrar su resultado y su consumo. La lectura de una evaluación huérfana pasada de plazo la cierra como fallida y conserva los casos ya guardados. Repetir el UUID recupera ese estado.
- **PostgreSQL.** Un proceso hijo murió por `SIGKILL` mientras esperaba el segundo caso del proveedor local. El primer resultado y su consumo liquidado se conservaron. La reserva del segundo quedó abierta al faltar confirmación. Al vencer el plazo, un nuevo evaluador recuperó el resultado parcial, rechazó publicar y no hizo otra llamada al proveedor.
- **Chrome.** Bravo canceló con teclado desde una pantalla de 390 px y vio la confirmación mientras el caso iniciado seguía pendiente de registro. Tras completarse ese registro, la pantalla y la consulta después de recargar mostraron un único caso aprobado. La publicación siguió deshabilitada. Alfa recibió `404` al intentar cancelar la ejecución de Bravo.
- **Reproducción.** Ejecutar las suites de IA-01 a IA-03 contra la base local migrada y el proveedor HTTP de prueba. Pasaron 41 pruebas de backend de Studio y los 13 recorridos de Playwright, además de ambos builds, la comprobación de tipos del backend y las pruebas del cliente web.

## WF-01. Ingreso mientras se revierte una revisión publicada

- **Antes.** CI devolvió `WORKFLOW_NOT_PUBLISHED` durante una reversión válida. La regresión local mantuvo la reversión abierta hasta observar en PostgreSQL que un webhook esperaba su bloqueo. El ingreso falló al intentar fijar la revisión mediante una consulta que también bloqueaba la definición.
- **Después.** El ingreso bloquea la definición primero y lee la revisión publicada en una consulta posterior. La prueba con Temporal y PostgreSQL aceptó 40 webhooks durante la reversión y los fijó a la revisión restaurada. La ejecución previa conservó su revisión original y siguió inaccesible para la otra empresa.

## Recorridos por cerrar

| Recorrido | Evidencia pendiente |
| --- | --- |
| Bandeja en tiempo real | Filtro por etiqueta, reconexión, reorden de webhooks e historial paginado cubiertos en MSG-04 y MSG-05. |
| Envío y recepción | Toma de control, ventana de atención, reintento, adjuntos y recuperación de una entrega incierta cubiertos en MSG-06. |
| Harness IA | IA-03 e IA-04 cubren publicación, ejecución de texto, cancelación y recuperación de resultados parciales en modo de verificación. Completar la admisión coordinada del proveedor de producción y los perfiles restantes. |
| Flujo operativo y navegación | Atención, pedido, pago, aprobación y conexión. Recorrer como administrador y operador, con teclado y diferentes tamaños de pantalla. |
