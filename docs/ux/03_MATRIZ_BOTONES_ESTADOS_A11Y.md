# Matriz de Botones, Estados Globales y Accesibilidad (WCAG 2.2 AA)
## Whatsap-Automat v0.4 — Plantilla de QA de Experiencia

**Fecha:** Octubre 2026  
**Rol:** Lead Product Designer, UX Engineer & Frontend Architect  
**Referencia:** Blueprint v0.4 §11.3 y QA Gates §13

---

## 1. Matriz Exhaustiva de Botones e Interacciones

| Pantalla | Identificador | Permiso Requerido | Condición de Habilitación | Acción API / Dispatched Event | Estado Asíncrono (Loading) | Error Esperado | Rollback Visual | Prueba E2E | Criterio a11y (WCAG 2.2 AA) |
|---|---|---|---|---|---|---|---|---|---|
| **Shell** | `btn-tenant-select` | Autenticado | Siempre habilitado si `tenants.length > 1` | Abre modal selector; `POST /api/auth/switch-tenant` | Spinner en avatar de empresa | `403 Tenant Inactivo` | Mantiene tenant previo en UI | `test_switch_tenant_e2e` | `aria-haspopup="dialog"`, `aria-expanded` |
| **Shell** | `btn-sidebar-toggle` | Cualquiera | Siempre | Actualiza `localStorage` y estado Jotai | Inmediato (<16ms, CSS transition) | N/A | Vuelve a estado previo | `test_sidebar_collapse` | `aria-label="Colapsar menú lateral"`, foco visible |
| **Shell** | `btn-command-palette`| Cualquiera | Siempre (`Ctrl+K`) | Abre modal de búsqueda global | Inmediato | N/A | Cierra modal al pulsar `Esc` | `test_command_palette_open`| `aria-keyshortcuts="Control+K"`, `focus-trap` |
| **Shell** | `btn-operator-status`| `INBOX_OPERATE`| Operador en sesión activa | `PUT /api/operators/me/status` `{ status }` | Píldora pulsante tenue | `500 Error de red` | Revierte píldora al estado anterior | `test_operator_status_change`| `role="combobox"`, lectura de cambio por SR |
| **Inbox** | `btn-channel-filter` | `INBOX_READ` | Siempre | Filtra lista local y actualiza query param | Skeleton tenue en lista (100ms) | N/A | Vuelve a filtro 'Todos' | `test_filter_by_channel` | `role="tab"`, `aria-selected="true/false"` |
| **Inbox** | `btn-takeover-chat` | `INBOX_OPERATE`| Chat activo con IA o en espera | `POST /api/inbox/:id/takeover` con `state_version` | Texto cambia a "Tomando...", spinner | `409 Version Conflict` (otro operador lo tomó) | Muestra banner de advertencia, recarga chat | `test_takeover_chat_concurrency` | `aria-live="polite"`, `aria-label="Tomar control"` |
| **Inbox** | `btn-toggle-ia-pause`| `INBOX_OPERATE`| Chat seleccionado | `POST /api/inbox/:id/pause-ia` `{ durationHours }`| Spinner en icono de pausa/play | `400 Invalid Chat State` | Botón mantiene estado anterior | `test_pause_resume_ia` | `aria-pressed="true/false"`, tooltip explícito |
| **Inbox** | `btn-ai-suggest-reply`| `INBOX_OPERATE`| Chat seleccionado y mensaje reciente de cliente | `POST /api/inbox/:id/suggest` | "Generando...", spinner destellante | `429 Rate Limit` / `504 Timeout` | Limpia banner, muestra toast con reintento | `test_ai_suggestion_flow` | Anuncio de generación a lector de pantalla |
| **Inbox** | `btn-ai-accept-suggestion` | `INBOX_OPERATE`| Sugerencia visible y no expirada | Copia texto a composer o `POST /api/inbox/:id/send` | Transición suave a composer | N/A | Conserva sugerencia si falla foco | `test_accept_suggestion` | `aria-keyshortcuts="Control+Enter"` |
| **Inbox** | `btn-ai-regenerate`| `INBOX_OPERATE`| Sugerencia visible | `POST /api/inbox/:id/suggest?force=true` | Icono rotando, texto tenue | `500 LLM Provider Error` | Mantiene sugerencia previa intacta | `test_regenerate_suggestion` | `aria-label="Regenerar sugerencia de IA"` |
| **Inbox** | `btn-ai-reject-suggestion` | `INBOX_OPERATE`| Sugerencia visible | Cierra banner local; telemetría opcional | Ocultamiento inmediato | N/A | N/A | `test_reject_suggestion` | `aria-label="Descartar sugerencia"` |
| **Inbox** | `btn-composer-attach`| `INBOX_OPERATE`| Chat activo y ventana válida | Abre menú desplegable de adjuntos | Inmediato | N/A | Cierra menú con `Esc` o clic fuera | `test_open_attach_menu` | `aria-haspopup="menu"`, navegación por flechas |
| **Inbox** | `btn-composer-send` | `INBOX_OPERATE`| Texto no vacío O archivo listo, ventana válida | `POST /api/inbox/:id/messages` con `idempotencyKey` | Botón cambia a spinner; mensaje optimista | `400 Window Expired` / `413 File Too Large` | Marca mensaje con icono rojo "Error de envío" | `test_send_message_optimistic` | `aria-label="Enviar mensaje"`, enter para enviar |
| **Inbox** | `btn-template-select`| `INBOX_OPERATE`| Chat fuera de ventana 24h | Abre modal de plantillas aprobadas por Meta | Carga lista de plantillas con spinner | `502 Meta API Down` | Notifica imposibilidad de cargar HSM | `test_select_hsm_template` | `role="dialog"`, trampa de foco |
| **Studio** | `btn-agent-create` | `AGENT_MANAGE` | Siempre | Abre wizard de creación de agente | Redirige a nuevo draft | `400 Name Duplicate` | Mantiene formulario abierto con error | `test_create_agent_draft` | `aria-label="Crear nuevo agente"` |
| **Studio** | `btn-graph-validate` | `AGENT_MANAGE` | Grafo con al menos 1 nodo | Ejecución de validador local de topología | Barra de progreso superior | Resalta nodos con error en rojo | Mantiene foco en primer nodo inválido | `test_validate_agent_graph` | Lista de errores vinculada con `aria-describedby` |
| **Studio** | `btn-graph-simulate` | `AGENT_MANAGE` | Grafo validado sin errores fatales | Abre drawer de Sandbox con chat simulado | Nodos se iluminan secuencialmente | `Timeout en nodo LLM` | Muestra nodo fallido con borde ámbar | `test_simulate_graph_sandbox`| Anuncios por lector de ejecución paso a paso |
| **Studio** | `btn-graph-publish` | `AGENT_PUBLISH`| Borrador con cambios válidos no publicados | `POST /api/agents/:id/publish` con `confirmHash` | Modal de confirmación + spinner | `409 Outdated Draft` | Despliega diff y pide refrescar cambios | `test_publish_agent_version` | Modal accesible con confirmación explícita |
| **Studio** | `btn-graph-rollback`| `AGENT_PUBLISH`| Historial con al menos 1 versión anterior | `POST /api/agents/:id/rollback` `{ versionId }` | Spinner de restauración | `403 Insufficient Privileges` | Mantiene versión actual intacta | `test_rollback_agent_version`| Confirmación con doble paso destructivo |
| **Auto** | `btn-workflow-dryrun`| `WORKFLOW_MANAGE`| 5 pasos del wizard completados | `POST /api/workflows/dry-run` `{ definition }` | Animación de engranaje en paso 5 | `422 Rule Schema Invalid` | Resalta campo con regla inválida | `test_workflow_dryrun_e2e` | Tabla de acciones simuladas accesible |
| **Auto** | `btn-workflow-activate`| `WORKFLOW_MANAGE`| Dry-run superado con éxito | `POST /api/workflows/:id/activate` | Spinner en botón de guardado | `409 Workflow Active Conflict` | Mantiene estado en borrador | `test_activate_workflow` | Feedback de éxito anunciado por `aria-live` |
| **Approvals**| `btn-approval-approve` | `APPROVAL_RESOLVE`| Aprobación pendiente y TTL vigente | `POST /api/approvals/:id/approve` con CAS token | Deshabilita botones de tarjeta, spinner | `410 Expired` / `409 Already Processed` | Tarjeta se marca como "Expirada/Procesada" | `test_approve_action_cas` | Confirmación previa si riesgo es Alto |
| **Approvals**| `btn-approval-reject` | `APPROVAL_RESOLVE`| Aprobación pendiente | Abre modal de motivo; `POST /api/approvals/:id/reject` | Spinner al confirmar motivo | `400 Reason Required` | Mantiene modal abierto con alerta | `test_reject_approval_reason`| `aria-required="true"` en campo de motivo |
| **Ops** | `btn-dlq-retry` | `OPS_ADMIN` | Tarea en estado Failed en DLQ | `POST /api/operations/dlq/:id/retry` | Icono rotando, fila en gris tenue | `502 Upstream Down` | Restaura fila con mensaje de error actualizado | `test_retry_dlq_message` | `aria-label="Reintentar tarea fallida"` |
| **Canales** | `btn-channel-ping` | `CHANNEL_MANAGE` | Credenciales de webhook guardadas | `POST /api/channels/:id/test-webhook` | "Enviando ping de prueba...", spinner | `400 Webhook URL Unreachable` | Muestra tarjeta roja con código de diagnóstico | `test_ping_channel_webhook`| `role="status"` en resultado del ping |
| **Móvil** | `btn-mobile-biometric`| Autenticado previo | Dispositivo con hardware biométrico habilitado | Validación local Keychain / Keystore | Animación de escaneo facial/huella | `Autenticación Cancelada` | Permite ingresar contraseña tradicional | `test_biometric_login_mobile`| Soporte VoiceOver / TalkBack nativo |

---

## 2. Matriz de Estados Globales del Sistema

Cada estado global debe ser manejado con componentes declarativos consistentes, evitando pantallas en blanco o mensajes técnicos incomprensibles.

```text
┌────────────────────────────────────────────────────────────────────────┐
│ ESTADOS GLOBALES DE LA INTERFAZ                                        │
├───────────────────────┬────────────────────────────────────────────────┤
│ ESTADO                │ TRATAMIENTO VISUAL Y DE INTERACCIÓN            │
├───────────────────────┼────────────────────────────────────────────────┤
│ 1. No Tenant          │ Modal bloqueante para seleccionar o crear      │
│    Seleccionado       │ organización. Deshabilita navegación operativa.│
├───────────────────────┼────────────────────────────────────────────────┤
│ 2. Sin Conexión       │ Banner fijo ámbar superior: "Modo offline:     │
│    (Network Down)     │ los cambios se sincronizarán al reconectar".   │
├───────────────────────┼────────────────────────────────────────────────┤
│ 3. Sesión Expirada    │ Modal no disruptivo de reautenticación in-situ;│
│    (Token Expired)    │ no borra formularios no guardados ni drafts.   │
├───────────────────────┼────────────────────────────────────────────────┤
│ 4. Estado Vacío       │ Ilustración neutra + explicación + CTA claro:   │
│    (Empty State)      │ ej. "No hay aprobaciones pendientes. ¡Al día!".│
├───────────────────────┼────────────────────────────────────────────────┤
│ 5. Permisos 403       │ Vista "Acceso Restringido" con rol actual y    │
│    (Forbidden)        │ botón para solicitar acceso a administrador.   │
├───────────────────────┼────────────────────────────────────────────────┤
│ 6. Límite de Tasa 429 │ Cuenta regresiva visual: "Reintentando en 14s". │
│    (Rate Limited)     │ Bloquea temporalmente el botón causante.       │
├───────────────────────┼────────────────────────────────────────────────┤
│ 7. Conflicto CAS 409  │ Diff modal: "La conversación cambió en otro    │
│    (Version Stale)    │ equipo. Compara y confirma tu actualización".  │
├───────────────────────┼────────────────────────────────────────────────┤
│ 8. Aprobación 410     │ Badge gris inactivo: "Esta acción caducó hace  │
│    (TTL Expirada)     │ 5 minutos y no puede ser ejecutada".           │
└───────────────────────┴────────────────────────────────────────────────┘
```

### Especificación de Comportamiento:

1. **Sin Conexión / Reconexión (Offline Engine):**
   - El cliente detecta la pérdida de señal mediante eventos de Socket.IO (`disconnect`) y la API nativa `navigator.onLine`.
   - Se activa una barra superior fija `bg-amber-500 text-white font-medium px-4 py-2 text-center text-sm` con icono de antena desconectada.
   - Toda mutación iniciada durante el periodo offline se almacena en memoria local (`IndexedDB` en web, `SQLite` en móvil) con estado `queued`.
   - Al restablecerse la red, se ejecuta una sincronización automática con retroceso exponencial (exponential backoff con jitter) para evitar tormentas de peticiones.

2. **Conflicto de Versión / Estado Desactualizado (CAS Mismatch):**
   - Cuando una petición devuelve HTTP 409 (debido a que `conversation_state_version` en servidor es superior a la del cliente), la interfaz no descarta el texto escrito por el operador.
   - En su lugar, abre un modal lateral que muestra:
     * El mensaje que otro operador o la IA envió mientras tanto.
     * El borrador que el usuario intentaba enviar.
     * Botón `[Integrar y Enviar de todos modos]` o `[Descartar mi borrador]`.

3. **Reautenticación sin Pérdida de Contexto (Session Refresh):**
   - Si el `accessToken` expira y el `refreshToken` falla o requiere re-login, la aplicación no ejecuta un `navigate('/auth/login')` inmediato que destruiría el grafo o borrador que el usuario estaba editando.
   - Presenta un modal emergente (`zIndex: 10000`) pidiendo contraseña o credenciales SSO. Al validar, cierra el modal y reintenta la petición fallida de forma transparente.

---

## 3. Checklist de Cumplimiento WCAG 2.2 Nivel AA

Todos los componentes del Workspace Unificado deben superar los siguientes criterios de aceptación antes de recibir aprobación de QA:

- [ ] **1.4.3 Contraste Mínimo:** Todos los textos normales cumplen con un ratio mínimo de contraste de 4.5:1 contra su fondo; textos grandes (18pt o 14pt negrita) cumplen al menos 3:1.
- [ ] **2.1.1 Teclado:** Toda acción realizable con el ratón (incluido el dibujo y conexión de nodos en el grafo de Agent Studio) cuenta con un equivalente completo por teclado.
- [ ] **2.1.2 Sin Trampas de Teclado:** El foco nunca queda atrapado de forma irreversible en ningún componente o iframe.
- [ ] **2.4.3 Orden del Foco:** Al navegar con la tecla `Tab`, el orden sigue una jerarquía lógica de izquierda a derecha y de arriba abajo.
- [ ] **2.4.7 Foco Visible:** Todo elemento interactivo muestra un anillo de foco visible (`ring-2 ring-emerald-500 ring-offset-2`) al recibir navegación por teclado.
- [ ] **3.3.1 Identificación de Errores:** Los errores en formularios se señalan con texto explícito (no solo cambio de color) y están asociados al input mediante `aria-describedby`.
- [ ] **4.1.2 Nombre, Rol y Valor:** Todo botón con icono dispone de `aria-label` descriptivo y todo control custom implementa los roles WAI-ARIA correspondientes (`role="dialog"`, `role="combobox"`, `role="tablist"`).
- [ ] **4.1.3 Mensajes de Estado:** Los cambios dinámicos (llegada de mensaje nuevo, actualización de estado de agente) se notifican mediante regiones `aria-live="polite"` sin robar el foco del usuario.
