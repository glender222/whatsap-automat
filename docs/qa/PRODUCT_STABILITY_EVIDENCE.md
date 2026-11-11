# Evidencia de estabilidad del producto

Este registro separa los recorridos verificados y los pendientes. Para cerrar un defecto se registra la reproducción, el cambio y el resultado de la regresión. Cuando el recorrido cruza empresas, la evidencia identifica los roles y la separación comprobada.

El job `product-smoke` ejecuta la prueba de sesión Socket.IO y tres pasos de Chromium con bases aisladas y proveedores locales. Los pasos de navegador fallan si omiten algún recorrido y conservan informes y trazas ante fallos. La línea base `eb0424b` tiene los 11 trabajos de CI aprobados. El candidato 067 compone el catálogo publicado con WhatsApp y conserva los recorridos generales y de Mercado Pago. La prueba de sesión Socket.IO tiene nueve casos. [Workflow de CI](../../.github/workflows/ci.yml).

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

## UX-05. El borrador se pierde al volver de Pedidos

- **Antes.** Chromium escribió un texto en la conversación de Alfa, abrió Pedidos con el teclado, esperó que la vista cargara y volvió por el historial. El cuadro de mensaje estaba vacío.
- **Después.** El texto y la referencia exacta de un envío en curso viven en el estado de la sesión. El borrador reaparece al volver a la misma conversación. Al cambiar de cuenta a Bravo en otra pestaña, el mismo contacto y el mismo identificador de WhatsApp muestran el historial de Bravo y el cuadro de mensaje vacío.
- **Recibo durante la navegación.** Graph local perdió el acuse de un envío. El operador abrió Pedidos y, mientras estaba allí, llegó el recibo firmado. Al volver se mostró una sola copia del mensaje y se limpió el borrador correspondiente. Graph no recibió un nuevo POST. Pasaron los 14 recorridos de Chromium y el build web.

## UX-06. El filtro «Por cobrar» omite pedidos antiguos

- **Antes.** La pantalla filtraba solo las primeras 100 filas ya paginadas. Chromium reprodujo la ausencia de un cobro fuera de esa página. PostgreSQL devolvió 106 registros para una consulta que debía devolver los 3 cobros pendientes del fixture.
- **Después.** La API filtra antes de contar y paginar. La UI muestra el total filtrado, permite recorrer las páginas y vuelve a la última disponible si una operación elimina la página actual. Chromium verificó el filtro en escritorio y móvil, una respuesta tardía y la recuperación de una página vacía. La suite combinada pasó 18 recorridos sin omisiones. Las 12 pruebas HTTP y PostgreSQL incluyeron el filtro, el aislamiento por empresa y la conciliación interna de Mercado Pago.

## UX-07. El recorrido entre la conversación, el pedido y el pago

- **Antes.** El historial del cliente mostraba el pedido sin enlace. Desde el pedido había que localizar el cobro otra vez en Pagos.
- **Después.** Se puede abrir el pedido desde el historial y volver a la conversación con el borrador y el foco. El administrador abre Pagos y conciliación con el pedido ya seleccionado. El regreso conserva la conversación y la página del listado. El operador conserva el acceso a su contexto y la pantalla explica el requisito de administrador.
- **Validación.** Siete pruebas de Chromium recorren los módulos con respuestas HTTP controladas. Incluyen escritorio, pantalla estrecha, teclado, Escape, recarga y un identificador inválido. La suite completa pasó 25 recorridos. [Diseño del recorrido](../../Frontend_py_whatsaapweb/docs/DESIGN.md).

## UX-08. Regreso y vencimiento en aprobaciones

- **Antes.** Al regresar desde una solicitud se perdían el filtro y la página. Una confirmación podía quedar abierta tras vencer, y si fallaba la consulta al vencimiento se perdía el foco.
- **Después.** La cola conserva riesgo y página en la URL y restaura el foco de la solicitud de origen. El detalle desactiva la decisión al vencer, cierra la confirmación y permite actualizar el estado si la consulta falló.
- **Validación.** Nueve casos de Chromium con PostgreSQL verifican los dos tamaños de pantalla, contraseña incorrecta y correcta, retiro de permisos durante la decisión, acceso entre empresas y reintento con pérdida de acuse. [Reproducciones y resultados](APPROVALS_OPERATOR_JOURNEY.md).

## UX-09. Diagnóstico y revocación de la conexión WhatsApp

- **Antes.** Configuración permitía guardar la línea y el token sin comprobar o desconectar desde la pantalla. Una credencial rechazada mostraba un error HTTP genérico.
- **Después.** Los administradores comprueban, revocan y vuelven a conectar su línea desde Configuración. Un error explica cómo continuar y la pantalla descarta el valor secreto al cambiar de sesión. El operador conserva la lectura del estado.
- **Validación.** Tres recorridos Chromium con API, PostgreSQL y Graph local comprobaron rechazo, indisponibilidad, reintento de revocación, reconexión, permisos y aislamiento entre dos empresas. [Reproducciones y resultados](WHATSAPP_CONNECTION_WORKFLOW.md).

## UX-10. Conciliación de Mercado Pago desde el navegador

- **Antes.** Al abrir la identificación manual en móvil se perdía el foco. Recuperar una liquidación guardada después de perder el acuse dejaba visible el error anterior.
- **Después.** El foco llega al campo de ID y vuelve al control de conciliación al cancelar o completar. La alerta del intento anterior desaparece cuando llega una observación nueva.
- **Validación.** Cuatro recorridos Chromium con API, PostgreSQL y Mercado Pago local comprueban pago parcial sin confirmar el pedido, liquidación única, devolución a revisión, recuperación del acuse y aislamiento de dos empresas. [Evidencia y reproducción](MERCADOPAGO_BROWSER_RECONCILIATION.md).

## UX-11. Pausa y foco con una revisión publicada de WhatsApp

- **Antes.** Bandeja deshabilitaba «Pausar IA» antes de la primera sugerencia. Desvincular con teclado dejaba el foco sin destino. Al reanudar podía aparecer de nuevo la sugerencia que existía antes de pausar.
- **Después.** La conversación canónica permite pausar y reanudar en cada etapa. Las mutaciones de vinculación devuelven el foco al selector de modo o al encabezado de la sección. El runtime fija la generación de propiedad y la marca de pausa para que el resultado viejo quede invalidado, incluso si la pausa vence.
- **Validación.** Chromium recorrió cambios de modo por teclado, pausa, conservación del borrador, reemplazo explícito, aislamiento y recuperación de un conflicto administrativo. PostgreSQL comprobó que pausar y reanudar durante la llamada al modelo bloquea la salida y que una respuesta automática autorizada genera un único envío. [Reproducción y pruebas](PUBLISHED_WHATSAPP_UX_REVIEW.md) · [Contrato de ejecución](STRICT_WHATSAPP_RUNTIME.md).

## UX-12. Volver al listado de Agent Studio desde una revisión

- **Antes.** En `3eb55ff`, desde la segunda página un administrador abría un grafo, recargaba, consultaba una revisión anterior y guardaba otra. «Volver a Agent Studio» enviaba a la primera página y el grafo quedaba fuera de vista. Chromium falló al comprobar la URL de regreso.
- **Después.** El cursor del listado viaja en la URL al consultar o editar una revisión y al abrir un grafo nuevo. Volver a la lista enfoca el grafo revisado. Cancelar la creación enfoca «Nuevo grafo» en la misma página.
- **Validación.** Chromium con API y PostgreSQL recorrió el caso desde Bandeja con teclado y un viewport de 390 px. Verificó la segunda página después de recargar, cambiar de revisión, cancelar o guardar, recuperar el foco y conservar Oscuro con el sistema en Claro. [Prueba de navegador](../../Frontend_py_whatsaapweb/e2e/agent-studio.integration.spec.ts).

## UX-13. Atrás del navegador y cambio de empresa en Agent Studio

- **Antes.** Atrás desde un detalle conservaba la página 2 y devolvía el panel al inicio, con el foco en `BODY`. Una segunda reproducción cambió de empresa tras usar el enlace de regreso y la nueva sesión heredó el foco del grafo homónimo.
- **Después.** La lista recupera el enlace y el desplazamiento de la entrada de historial de la sesión activa, incluso al recargar el detalle. El enlace de regreso explícito verifica su sesión de origen. El editor enfoca el encabezado al montarse, corrigiendo una carrera de teclado observada en móvil en CI.
- **Validación.** Siete recorridos de Studio en Chromium cubrieron teclado, escritorio, móvil, Claro y Oscuro, recarga, Atrás y Adelante, y cambio entre empresas con los mismos identificadores de grafo. Diez pruebas de grafos y diez de sesión pasaron. [Reproducción y comandos](AGENT_STUDIO_HISTORY_RETURN.md).

## MSG-01. Conversaciones nuevas y recuperación de la bandeja

La traza de GitHub Actions mostró que el corte de red podía coincidir con la carga inicial de la conversación. La regresión ahora espera que aparezca el mensaje inicial en el historial antes de cortar la red. Así comprueba la recuperación después de una desconexión establecida.

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

## MSG-07. Respuesta automática tras reiniciar el proceso

- **Antes.** Un `SIGKILL` después de confirmar el mensaje dejaba el webhook como procesado y cero trabajos pendientes. Al repetir el webhook, la respuesta automática se omitía.
- **Después.** La recepción y el trabajo quedan en la misma transacción. El reinicio recupera el mismo UUID y el mismo mensaje. PostgreSQL comprueba el orden dentro de una conversación, la validez de la línea y el aislamiento por empresa.
- **Segundo corte.** Graph local recibió el POST y el proceso murió antes de recibir el acuse. La reserva persistida conservó el envío incierto. Tras reiniciar, el webhook duplicado no produjo otro POST. Un recibo firmado confirmó la entrega y el mensaje siguiente recibió su propia respuesta. Las pruebas de envío también comprobaron dos empresas, rechazo de recibos ajenos y pausa o toma de control antes de admitir un envío.
- **Validación.** Pasaron 31 pruebas de PostgreSQL y procesos, las dos pruebas del producto con réplicas de la API, 251 pruebas del backend y 18 recorridos de Chromium. [Procedimiento y límites de recuperación](META_INBOUND_DURABLE_RECOVERY.md).

## MSG-08. Respuesta automática publicada y recibos en la bandeja

Chromium amplía el recorrido de Studio en modo proveedor con la aplicación y PostgreSQL reales, un modelo local y dos líneas de Graph local. Alfa vincula su revisión en modo automático y habilita la automatización de la empresa. Alfa recibe dos veces el mismo webhook firmado. Bravo recibe un texto distinto con el mismo remitente e identificador externo.

La bandeja de Alfa muestra un mensaje entrante y una respuesta automática. Graph registra un solo envío, por la línea de Alfa, y ninguno por la de Bravo. La aceptación del proveedor aparece como «Aceptado por WhatsApp». Un recibo de lectura presentado por Bravo no altera ese estado. Los recibos propios cambian la respuesta a «Enviado» y «Leído». Un recibo «Entregado» posterior y una recarga conservan «Leído» y la misma respuesta única. La bandeja de Bravo muestra su propio mensaje. [Prueba de Studio y WhatsApp](../../Frontend_py_whatsaapweb/e2e/agent-studio.integration.spec.ts).

## UX-14. Vincular un catálogo y recuperar su estado desde Studio y Bandeja

- **Recorrido.** En móvil y con teclado, Alfa y Bravo evalúan, publican y vinculan su propio catálogo. Ambas empresas reciben el mismo contacto e ID externo. Bandeja muestra la sugerencia identificada por perfil y revisión, con el producto de la empresa correspondiente.
- **Recuperación.** Recargar conserva la sugerencia autorizada. Pausar y reanudar la conversación descarta la anterior. Cambiar a modo automático conserva un único envío ante el webhook duplicado y recibe la marca de lectura desde Graph local.
- **Administración.** Studio permite consultar y desvincular el pin histórico cuando el perfil deja de admitir nuevas vinculaciones. La prueba combina el binding guardado en PostgreSQL con respuestas de disponibilidad controladas, verifica el DELETE real con CAS y devuelve el foco al título.
- **Evidencia.** El recorrido usa dos sesiones de Chromium a 390 px, App, PostgreSQL, Socket.IO y transportes locales de modelo y Graph. Las pruebas conservan capturas de Studio y Bandeja y comprueban el ancho de la página.

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

## IA-05. Una cuota por empresa para ejecución y evaluación

- **Política.** La migración 060 registra la admisión por empresa. El modo por defecto conserva el proveedor anterior. El paso a `draining` bloquea operaciones nuevas del proveedor anterior. El paso a `strict` exige que terminen las operaciones en curso. Una caída con un permiso abierto conserva el registro para revisión.
- **Prueba integrada.** La API autenticada de Alfa ocupó el presupuesto con una solicitud retenida por el proveedor HTTP local. Una evaluación de Studio de Alfa quedó bloqueada sin despachar. Bravo pudo ejecutar con su propio presupuesto y credencial. Al completar la primera solicitud, una evaluación nueva de Alfa pasó y el libro de consumo registró ambos usos. La publicación en modo proveedor no apareció en modo de verificación.
- **Control.** PostgreSQL rechazó cambiar de modo mientras seguía activo el permiso anterior, incluso después de un `SIGKILL`. La API de credenciales rechazó guardar y probar una clave con rol de operador. La pausa impidió nuevas solicitudes de Alfa.
- **Alcance.** El gateway de texto admite empresas configuradas con la política y una credencial BYOK de OpenAI. IA-06 conecta el mismo presupuesto a Studio desde la API y el navegador. [Política y prueba local](AI_PROVIDER_ADMISSION.md).

## IA-06. Modo proveedor de Studio desde la aplicación

- **Antes.** El servidor principal solo mostraba la ejecución en la composición de verificación. El evaluador de proveedor quedaba accesible únicamente desde la prueba interna.
- **API y PostgreSQL.** El administrador de Alfa registró una credencial, evaluó, publicó y ejecutó la revisión de texto. Al repetir el UUID se conservó el resultado de evaluación y el envío de ejecución no se repitió. Bravo no pudo consultar ni usar la publicación de Alfa. En pausa, Alfa pudo consultar la evaluación y el servidor rechazó nuevas ejecuciones. Studio y la API operativa comparten la cuota de IA-05.
- **Navegador.** Dos administradores en pantallas de 390 px vieron la acción de configurar credenciales. Alfa guardó su clave en Studio y el formulario borró el valor. Evaluó con teclado, recuperó el resultado al recargar, publicó y ejecutó. Bravo siguió sin credencial y con el botón deshabilitado, incluso al enviar desde un formulario obsoleto de Alfa después de cambiar de sesión. La sesión de proveedor ignoró un UUID guardado bajo el modo de verificación.
- **Alcance.** El navegador usa la composición predeterminada de la aplicación y un proveedor HTTP local. Quedan el piloto con una credencial real y los perfiles del runtime con herramientas. [Reproducción](AI_PROVIDER_ADMISSION.md).

### Crear la revisión desde el navegador

El ejemplo inicial del editor validaba estructura, pero no preparaba el modelo ni la reserva de contexto. El recorrido de proveedor ahora empieza en «Nuevo grafo» para las dos empresas. El servidor genera una plantilla compatible a partir de la capacidad vigente. Alfa guarda la revisión desde la interfaz y evalúa dos casos con el presupuesto de la plantilla. Antes del cambio, el recorrido fallaba al buscar el control para cargarla.

## IA-07. Derivación del agente en modos de solo lectura y prueba

- **Antes.** Una solicitud de la herramienta de pagos desactivada creó un ticket en modo Asistido. La derivación por una respuesta inválida del modelo también podía invocar el servicio de tickets directamente.
- **Después.** Ambas rutas pasan por el ejecutor que aplica los permisos del módulo y la herramienta, el modo de la empresa y del agente, y la simulación sin efectos. El modo Automático autorizado conserva la derivación para cobros y registra el resultado de la herramienta.
- **Reproducción.** `node --import tsx --test src/test/tools-reales-ia.test.ts src/test/multiagent-routing-p0.test.ts` desde el backend. La prueba comprueba las llamadas al servicio que escribe los tickets y verifica que el fallback del runtime pasa por el mismo ejecutor.

## IA-08. Reclamo duradero de efectos de herramientas

- **Antes.** Dos procesos con la misma clave dejaron dos recibos para un efecto. Matar un proceso después de escribir el recibo y antes de guardar el resultado también causó dos efectos al reiniciar.
- **Después.** La migración 061 vincula la clave a la empresa, la ejecución, la herramienta y los argumentos. Solo el proceso que confirma el reclamo puede invocar el efecto y guardar el resultado. El broker conserva un resultado incierto para inspección cuando falta el acuse.
- **Validación.** La regresión con PostgreSQL y procesos separados conserva un recibo por clave en ambas reproducciones. También comprueba permiso revocado, parámetros distintos con la misma clave, acuse perdido antes y después del commit, fallo de PostgreSQL y aislamiento de resultados entre Alfa y Bravo. Los registros históricos se conservan para inspección. [Pruebas, despliegue y recuperación](../../WhatsaapWeb-JS/docs/tool-effect-claims.md).

## IA-09. Acuse de ejecución perdido al recargar Studio

- **Antes.** El backend completaba una ejecución de la revisión publicada. Si se perdía la respuesta HTTP y la página se recargaba, el navegador olvidaba el identificador. Enviar de nuevo el mismo texto podía reservar cuota y llamar al proveedor otra vez.
- **Después.** La pestaña conserva solo el identificador y el plazo del intento por usuario, empresa, revisión y modo. Studio pide reintroducir el mismo texto y reutiliza ese identificador. La nueva ejecución es una acción explícita que prepara el formulario y devuelve el foco al campo. Las solicitudes del panel también se vinculan a la sesión que abrió Studio.
- **Validación.** Chromium dejó que la API completara el intento de Alfa y descartó su respuesta. Tras recargar, Alfa reenvió el mismo identificador y la API devolvió `not_dispatched`. El texto no quedó en el almacenamiento de la pestaña y la interfaz de Bravo no mostró ese intento. La reserva de cuota conserva la evidencia del despacho. La salida de texto original solo está disponible si su primera respuesta llega al navegador.

## IA-10. Revisión publicada de texto en el runtime de WhatsApp

- **Antes.** Alfa podía ejecutar el modelo estricto con cuota, pero el siguiente mensaje de WhatsApp terminaba omitido. Bravo seguía por el runtime anterior.
- **Después.** Un administrador fija explícitamente una revisión y huella. El runtime liga el trabajo entrante al intento del modelo y confirma cuota y salida cifrada en la misma transacción. Si se interrumpe la entrega, recupera la salida confirmada sin repetir la inferencia. Si falta confirmación, conserva la incertidumbre. Antes de entregar vuelve a comprobar el vínculo, el modo y el control de la conversación.
- **Validación.** Pasaron 28 pruebas PostgreSQL de cuota, pin, API y worker. Con Chromium y proveedores locales, Alfa vinculó la revisión, recibió un mensaje firmado y vio una sola notificación Socket.IO sin texto. La sugerencia se recuperó después de recargar y se copió al borrador sin enviar a Graph. Bravo recibió un mensaje con el mismo identificador externo y no recibió esa sugerencia ni notificación. Un cambio administrativo concurrente protegió la vinculación de un retiro obsoleto.
- **Alcance.** El perfil admite una llamada de texto. Los perfiles de router y herramientas conservan sus propios requisitos de evaluación y recuperación. [Contrato, migración y reproducción](STRICT_WHATSAPP_RUNTIME.md).

## IA-11. Evaluar el router de catálogo desde Agent Studio

- **Antes.** El perfil de texto rechazaba un grafo con router y herramienta. El primer ensayo de catálogo podía registrar el consumo del router y perder el resultado necesario para continuar tras reiniciar el proceso.
- **Después.** `catalog-router-v1` fija cada ronda y la lectura autorizada en PostgreSQL. Studio guarda suites con expectativas de texto y de herramientas. La evaluación contrasta las expectativas con el registro de la herramienta y los dos ledgers de cada caso. Reintentar el mismo run recupera lo confirmado y un resultado incompleto no aprueba la suite.
- **Validación.** La instalación limpia y la actualización desde 064 pasaron. Ochenta y cuatro pruebas combinadas cubrieron catálogo, Studio, cuotas y runtime estricto de texto. Chromium usó la aplicación y PostgreSQL con Alfa y Bravo, el mismo identificador de grafo y productos distintos. Cada empresa aprobó un caso con búsqueda y otro sin ella, recuperó el resultado al recargar y comprobó cuatro ledgers propios. El API rechaza publicar esta evaluación y la interfaz omite esa acción. [Arquitectura, contrato y reproducción](../architecture/CATALOG_STUDIO_EVALUATIONS.md) · [Prueba de navegador](../../Frontend_py_whatsaapweb/e2e/agent-studio-catalog.integration.spec.ts).

## IA-12. Publicación del perfil de catálogo con evidencia vigente

- **Antes.** Una evaluación aprobada del router de catálogo sólo producía evidencia de Studio. La API rechazaba publicar el perfil. En la primera prueba de la nueva publicación, revocar el modo de Alfa después de evaluar producía `409`, pero dejaba habilitado el botón con la evidencia anterior.
- **Después.** Studio publica una revisión exacta cuando la suite acredita un caso con `catalog.search` y otro con la herramienta prohibida. El recibo fija revisión, evidencia y permisos mediante hashes. Ante conflicto, Studio consulta el estado actual y enfoca la explicación. La revisión publicada sigue disponible como recibo histórico.
- **Validación.** Alfa y Bravo publicaron desde Chromium con el mismo identificador de grafo y catálogos separados. En Alfa, una suite de un solo camino quedó bloqueada y una revocación posterior a evaluar deshabilitó la publicación. Restablecer el acceso exigió una evaluación nueva. Ambas empresas consultaron su publicación tras recargar. El binding previo de texto conserva su revisión y los endpoints de ejecución y vínculo de catálogo permanecen cerrados en este corte. [Contrato y casos PostgreSQL](../architecture/CATALOG_STUDIO_PUBLICATIONS.md) · [Prueba de Studio](../../Frontend_py_whatsaapweb/e2e/agent-studio-catalog.integration.spec.ts).

## IA-13. Retención sin tráfico de Studio

- **Antes.** Dos empresas con checkpoints vencidos conservaban sus cifrados si nadie volvía a consultar una evaluación.
- **Después.** La aplicación recorre las empresas en páginas y limpia lotes de checkpoints vencidos. El borrado físico es eventual y conserva hashes, reservas y ledgers. Cerrar el servidor detiene nuevas admisiones y espera los lotes iniciados.
- **Validación.** La prueba de `App.start` observó por SQL la eliminación de cifrados de Alfa y Bravo sin usar HTTP. Una fila bloqueada quedó pendiente y la otra empresa avanzó. Se comprobaron lotes de 100, ejecución concurrente y arranque con el esquema anterior sin clave de cifrado. [Reproducción y comandos](CATALOG_CHECKPOINT_RETENTION.md).

## IA-14. Suites al cambiar el perfil de una revisión

- **Reproducción.** En un grafo con revisión 1 de catálogo y revisión 2 de texto, guardar una suite desde cada revisión y volver a abrir ambas en Studio. La API devolvía las dos suites al consultar cualquiera de las revisiones. El panel rechazaba la respuesta y desaparecía la selección.
- **Corrección.** Consultar por empresa, grafo y perfil de la revisión antes de aplicar el límite de 20. Las suites de revisiones del mismo perfil siguen disponibles en el mismo grafo.
- **Evidencia.** Chromium con App y PostgreSQL reprodujo la ausencia de opciones y pasó con ambas revisiones mostrando su propia suite y el botón de evaluación habilitado. La prueba está en `Frontend_py_whatsaapweb/e2e/agent-studio-catalog.integration.spec.ts` y se ejecuta en el paso de Studio proveedor del CI de producto.

## IA-15. Catálogo publicado en el turno canónico de WhatsApp

- **Reproducción.** Las publicaciones de catálogo evaluadas y aprobadas recibían HTTP 422 al vincularse a WhatsApp. Al conectar el runtime, un SIGKILL después de confirmar las rondas del modelo y antes de copiar el resultado a ready dejaba el turno sin recuperar.
- **Cambio.** La migración 067 fija perfil y recibo en el binding y en el run canónico. Las rondas de WhatsApp usan la operación completion y la misma cuota compartida. El worker recupera checkpoints confirmados y revalida el vínculo, la conversación, los permisos y el snapshot antes de continuar o entregar.
- **Pruebas.** Dos empresas publican y vinculan mediante la API, conservan su revisión fijada ante otra publicación y ofrecen sugerencias aisladas. Los casos detienen procesos después del router, del snapshot y antes y después de ready. Comprueban acuses perdidos del modelo y Graph, revocación, restauración de permisos, toma humana y pausa/reanudación.
- **Navegador.** Los tres recorridos proveedor de Studio pasaron sobre el candidato integrado. Incluyen texto, catálogo y cambio de perfil entre revisiones. Las llamadas al modelo y Graph usan servicios HTTP locales. [Contrato y recuperación](../architecture/CATALOG_WHATSAPP_RUNTIME.md).

## WF-01. Ingreso mientras se revierte una revisión publicada

- **Antes.** CI devolvió `WORKFLOW_NOT_PUBLISHED` durante una reversión válida. La regresión local mantuvo la reversión abierta hasta observar en PostgreSQL que un webhook esperaba su bloqueo. El ingreso falló al intentar fijar la revisión mediante una consulta que también bloqueaba la definición.
- **Después.** El ingreso bloquea la definición primero y lee la revisión publicada en una consulta posterior. La prueba con Temporal y PostgreSQL aceptó 40 webhooks durante la reversión y los fijó a la revisión restaurada. La ejecución previa conservó su revisión original y siguió inaccesible para la otra empresa.

## REL-01. Migraciones en compilaciones consecutivas

- **Antes.** Al compilar después de sustituir una migración local, el script copiaba la nueva y dejaba la descartada en `dist/db/migrations`. La API de código compilado devolvió 503 en `/ready` aunque PostgreSQL tenía aplicadas todas las migraciones del checkout.
- **Después.** El build copia las migraciones vigentes y retira del directorio generado los SQL ausentes del checkout. La comprobación de disponibilidad sigue exigiendo todas las migraciones de la aplicación.
- **Validación.** La prueba unitaria prepara un directorio de salida con un SQL descartado. Falla con el copiador anterior y pasa con el nuevo. `diff -qr src/db/migrations dist/db/migrations` confirmó que ambos directorios contienen los mismos archivos después de compilar. La API compilada respondió 200 en `/ready` sobre la misma base de conciliación. [Prueba del empaquetado](../../WhatsaapWeb-JS/scripts/copy-runtime-assets.test.cjs).

## Recorridos por cerrar

| Recorrido | Evidencia pendiente |
| --- | --- |
| Bandeja en tiempo real | Filtro por etiqueta, reconexión, reorden de webhooks e historial paginado cubiertos en MSG-04 y MSG-05. |
| Envío y recepción | MSG-06 a MSG-08 cubren envíos humanos y automáticos, adjuntos, entrega incierta, recuperación tras reinicio y recibos en la bandeja con Graph local. Falta el recorrido en navegador con dos líneas Meta reales. |
| Harness IA | IA-03 a IA-15 cubren Studio, cuota, derivaciones, reclamo de efectos, texto y el recorrido canónico del catálogo publicado. Faltan perfiles con herramientas de efectos, conciliación por proveedor y piloto con proveedor real. |
| Flujo operativo y navegación | UX-07 a UX-14 cubren conversación, pedido, pago y regreso, aprobación, conexión, conciliación con el proveedor local, pausa del agente publicado y regreso al listado de Studio. Falta el ensayo con una cuenta autorizada de Mercado Pago y la validación independiente del candidato completo. |
