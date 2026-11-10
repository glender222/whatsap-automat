# DESIGN - Frontend WhatsApp Business

Fecha de base: 2026-05-26

Este documento define la direccion visual y de experiencia del frontend. Debe vivir en `docs/` porque es documentacion permanente del producto. Las reglas obligatorias para Codex se resumen en `.codex/rules/ui-design.md`.

## Personalidad Del Producto

La aplicacion es una herramienta operativa para gestionar conversaciones, agentes, estaciones, configuracion y reportes. Debe sentirse profesional, rapida y confiable, no como una landing decorativa.

Principios:

- Claridad antes que adorno.
- Densidad moderada para trabajo diario.
- Estados visibles y accionables.
- Jerarquia simple: navegacion, lista, detalle y acciones.
- Compatibilidad visual entre desktop y mobile.

## Stack Visual

- Tailwind CSS como sistema principal de estilos.
- `lucide-react` para iconos.
- CSS global solo para utilidades compartidas, animaciones y tokens base.
- La preferencia Claro, Oscuro o Sistema se aplica antes de mostrar la aplicación. Persiste al cambiar de módulo, recargar o cambiar de sesión y se sincroniza entre pestañas del mismo navegador. Solo Sistema sigue cambios del tema del dispositivo. El tema efectivo se aplica al documento y a controles como el selector de emojis.

## Paleta Base

Usar una base neutral con acentos controlados:

- Fondos claros: blanco, slate/gris muy claro.
- Fondos oscuros: gray/slate profundo sin saturar demasiado.
- Accion primaria: verde/emerald para acciones WhatsApp o confirmaciones.
- Informacion: azul controlado.
- Alerta: amber.
- Error: red.

Evitar que toda la interfaz sea solo verde. El verde debe guiar acciones principales y estados relacionados con WhatsApp, no pintar todo el producto.

## Componentes Y Superficies

- Botones principales con icono cuando la accion sea reconocible.
- Cards solo para elementos repetidos, modales o paneles concretos.
- No anidar cards dentro de cards.
- Radio moderado; evitar estilos excesivamente redondeados en paneles operativos.
- Inputs con labels claros, mensajes de error cercanos y estados disabled/loading.
- Tablas y listas deben priorizar escaneo: nombres, estado, fecha, accion principal.

## Mensajeria

La pantalla de chats es el centro operativo:

- Bandeja izquierda estable para conversaciones.
- Panel central para mensajes con scroll confiable.
- Panel de detalle o contexto solo si aporta accion inmediata.
- Mensajes deben mostrar estado, media, hora y errores de envio cuando aplique.
- Los mensajes optimistas deben reconciliarse sin duplicados cuando llegue el evento socket.

## Configuracion WhatsApp

La UI debe soportar dos realidades:

- `webjs` legacy puede mostrar QR si el backend lo envia.
- `meta-cloud` no debe mostrar QR; debe mostrar configuracion, numero conectado, webhook y errores accionables.

Nunca pedir ni mostrar tokens de Meta en la UI final de usuario. La configuracion sensible pertenece al backend.

## Reportes Y Sprint 5

Para reportes, historial de cliente y mapa de calor:

- Priorizar filtros claros por fecha, cliente, etiqueta, agente y estado.
- Mostrar empty states utiles cuando no hay datos.
- Permitir exportar sin bloquear la lectura del reporte.
- En graficas, usar leyendas y ejes simples; evitar decoracion innecesaria.

## Accesibilidad Basica

- Contraste suficiente en texto y acciones.
- Botones con foco visible.
- No depender solo del color para comunicar errores o estados.
- Textos de botones cortos y concretos.
- Areas clicables comodas en mobile.

## Dashboard Operativo (Sprint 6)

El dashboard administrativo (`/dashboard`) es el centro de operaciones. Reemplaza al dashboard de modulos estaticos por un panel en tiempo real con bento grid:

- **QuickStatsRow**: 3 stat cards (tiempo de respuesta today, chats activos, pedidos hoy). Carga desde `/api/dashboard/quick-stats`.
- **ActionCards**: 3 cards accionables (Atender Chats, Validar Pagos, Actualizar Stock) con contadores + rutas. Carga desde `/api/dashboard/action-cards`.
- **MessageHeatmap**: matriz 7 dias x 24 horas con scroll horizontal. Intensidad de color sobre `#128C7E`. Carga desde `/api/dashboard/heatmap?days=7`.
- **SlaAlertsList**: lista de conversaciones criticas (espera >= umbral company, excluyendo `ai_ready`). Avatar inicial, nombre/phone, waitingMin, preview, statusTag derivado. Carga desde `/api/dashboard/sla-alerts`.
- **PaymentsPage** (`/dashboard/pagos`): tabla de comprobantes con filtros por estado, validar/rechazar con modal de motivo. Carga desde `/api/payments`.

Realtime: `useDashboardStats` suscribe Socket.IO a `chats-updated`, `message`, `payment-created`, `payment-updated`, `order-status-changed`, `stock-updated` con debounce 3s. Solo refresca las stats afectadas (no todas).

Definiciones operativas:
- Chats Activos = `conversations WHERE status='open' AND last_message_at::date = today (tz company)`.
- Pedidos Hoy = `COUNT customer_orders WHERE occurred_at::date = today` (sin filtro status).
- Atender Chats (pendientes) = chats con `unread_count>0` y sin tag_user asignado.
- Alertas SLA = `status=open AND unread>0 AND waitingMin >= sla_threshold_minutes` (configurable en `company_settings.sla_threshold_minutes`, default 5), excluyendo `statusTag='ai_ready'`.
- statusTag: `payment_pending` (comprobante pendiente) > `unassigned` (sin tag_user) > `ai_ready` (agente activo + unread=0) > `attention`.
- Low stock = `products WHERE status='active' AND min_stock>0 AND stock_available <= min_stock`.

Patrones nuevos:
- Stat cards: `rounded-2xl border border-[#D9E5DF] bg-white p-6 shadow-sm`, icono en caja `bg-{tone}/10`, valor `text-3xl font-bold`.
- Action cards: `border-l-4` con accent color, icono + contador, navigate a ruta.
- Heatmap: grid CSS `grid-cols-[56px_repeat(24,minmax(18px,1fr))]`, color por intensidad `rgba(18,140,126,intensity)`.
- SlaAlertsList: panel `flex flex-col h-[600px] lg:h-auto` con header sticky, scroll interno, footer link.

## Sistema IA Automatizador (Sprint 6 v3)

La IA es capa automatizadora transversal. Tres modos company configurables:

- **normal**: IA solo sugiere. Empleado revisa y envia.
- **mixed**: IA auto-responde + crea vouchers pendientes. No confirma pedidos.
- **automator**: IA auto-responde + auto-confirma pedidos (condiciones estrictas) + crea vouchers + genera links de pago on-demand.

Componentes frontend IA:
- **agentStateAtom** (Jotai): pendingSuggestion, iaPauseByChat, handoffTickets, runtimeLogFeed, autoReplyFeed, blockedFeed.
- **ChatContainer**: suggestion panel con Aceptar/Regenerar/Rechazar, boton Pausar IA per-chat, handoff banner con Tomar chat.
- **HandoffWidget** + **HandoffPage** `/dashboard/handoff`: cola de tickets derivados por IA.
- **RuntimeLogsViewer**: tab en AgentsPage, tabla con filtros chatId/status/action.
- **IaSettingsPage** `/dashboard/ia-settings`: radio modo IA + CRUD pasarelas de pago.
- **useAgentState** hook: socket events agent:suggestion, agent:auto_reply_sent, agent:blocked, agent:paused, agent:resumed, agent:handoff, agent:handoff_taken, agent:handoff_closed.

Role guards: `PrivateRoute adminOnly` aplica a `/dashboard/*`, `/gestion-web/agentes`, `/gestion-web/permisos`. Empleado retiene `/gestion-web/inicio`, `/gestion-web/reportes`.

Modulos eliminados:
- **bots/** (rule router): eliminado Sprint 6 v3. Era sistema separado de routing de chats por keywords/opciones. IA reemplaza su funcionalidad con triggerRules + decision engine.

## Cuando Actualizar Este Documento

Actualizar `docs/DESIGN.md` cuando:

- Cambie la navegacion principal.
- Cambie el estilo visual base.
- Se creen patrones nuevos de cards, modales, tablas o chats.
- Se definan nuevas pantallas del Sprint 5.
- Se cambie el comportamiento visual de WhatsApp Meta o WebJS.
- Se agreguen o quiten componentes del dashboard operativo.
- Cambien las definiciones de metricas (chats activos, pedidos hoy, SLA, statusTag).
- Se agreguen componentes del sistema IA (suggestion panel, handoff widget, gateways UI, runtime logs viewer).
- Se eliminen modulos obsoletos (ej: bots rule router eliminado en Sprint 6 v3).

## Espacio de trabajo operativo

La navegación de escritorio y móvil conserva el mismo orden entre bandeja, resumen y administración. En pantallas estrechas el menú se abre desde la barra superior. La bandeja y el hilo ocupan vistas separadas y el botón de regreso devuelve el foco al buscador. En escritorio, la lista y el hilo se muestran juntos.

Cada conversación tiene un enlace directo con su identificador. Cambiar de conversación cancela la carga anterior y conserva el borrador local del hilo. La cola general se carga desde la API de conversaciones aunque las etiquetas estén fuera de servicio.

En las conversaciones de WhatsApp Cloud, «Cargar mensajes anteriores» aparece al inicio del historial cuando quedan mensajes. Cargar una página conserva la posición de la primera fila ya visible y devuelve el foco a esa fila. Si la consulta falla, el mismo control permite reintentar. La bandeja sigue automáticamente la actividad nueva mientras el operador esté cerca del final del historial.

El detalle de un pedido abierto desde el listado conserva la página de origen en la URL. «Volver a pedidos» abre esa página incluso después de recargar el detalle. Las superficies, diálogos y controles de validación de pagos y conciliación usan los colores del tema activo del espacio de trabajo.

La lista de cobros y comprobantes aplica los filtros en el servidor y muestra el total completo del filtro activo. «Anterior» y «Siguiente» recorren páginas de hasta 100 casos; cambiar de filtro vuelve a la primera página. Si una operación deja vacía la última página, la lista vuelve a la última página disponible. Una respuesta de una página o filtro anterior no reemplaza la selección activa.

Agent Studio distingue la simulación de fixtures de la evaluación de ejecución. Cuando el servidor ofrece el modo de verificación, el detalle permite guardar suites de texto, consultar el resultado de una evaluación tras recargar, publicar la revisión aprobada y ejecutar esa revisión en el entorno de verificación. Los controles muestran la revisión activa y la incompatibilidad del perfil. El modo de la publicación se presenta junto a las acciones. La configuración habitual muestra que la publicación está indisponible.

Campañas muestra el listado del servidor y permite preparar borradores. Segmentos solicita el recuento al backend. Auditoría y Salud del sistema muestran el error de consulta cuando el servicio no está disponible.
