# Informe de Compatibilidad y Estrategia de Transición (PR-04)

**Fecha**: 2026-10-31  
**Autor**: Arquitecto de Software (Sesión 02 — PR-04)  
**Estado**: `READY_FOR_REVIEW`  
**Rama**: `implement_shared_contracts_pr04` (en worktree independiente)  

---

## 1. Resumen Ejecutivo

El objetivo primordial de **PR-04** es establecer el paquete de contratos compartidos versionados (`@whatsap-automat/contracts`), los esquemas de validación en tiempo de ejecución, los contratos canónicos omnicanal (WhatsApp Cloud, Instagram, Messenger, Telegram), modelos de agentes, workflows, aprobaciones y la especificación OpenAPI 3.1.0 inicial (`docs/api/openapi.v1.yaml` y `.json`), **sin romper los controladores productivos existentes ni las migraciones de base de datos actuales**.

Se ha aplicado un patrón estricto de **Arquitectura Hexagonal (Puertos y Adaptadores)** mediante:
1. `LegacyChannelAdapterBridge`: Adapta el puerto preexistente `MessageChannelPort` al nuevo puerto hexagonal `ChannelAdapterV1`.
2. `LegacyConversationMapper`: Mapea bidireccionalmente los DTOs vigentes (`InboundMessageDTO`, `OutboundMessageRequestDTO`, `ConversationDTO`, `ContactDTO`, `MessageStatusDTO`) con los contratos canónicos `ChannelEventV1`, `SendMessageCommandV1`, `ConversationV1` y `ChannelIdentityV1`.
3. Suite de **64 contract tests deterministas** ejecutados 100% en memoria con cero llamadas a redes externas ni base de datos, garantizando aislamiento estricto y paralelismo sin conflictos.

---

## 2. Matriz de Mapeo: Endpoints Legacy vs. Endpoints Canónicos v1

| Dominio | Endpoint Legacy (v0 / actual) | Endpoint Canónico v1 (PR-04 / OpenAPI) | Estrategia de Compatibilidad |
|---|---|---|---|
| **Workspaces / Tenant** | `/api/auth/me` | `GET /api/v1/workspaces/current` | Coexistencia. El backend legacy continúa respondiendo en `/api/auth/me`. En v1, el router resuelve `tenantId`, roles y capacidades del JWT. |
| **Conversaciones** | `/api/chats` (express legacy) | `GET /api/v1/conversations` | Coexistencia. La ruta `/api/chats` usa filtros legacy y arrays planos; `/api/v1/conversations` adopta paginación basada en cursor y filtros por `channel` y `stage`. |
| **Mensajes (Lectura)** | `/api/chats/:chatId/messages` | `GET /api/v1/conversations/{id}/messages` | El endpoint v1 utiliza el identificador interno de conversación (`id`) en lugar del JID externo (`chatId`), resolviendo estados normalizados de entrega (`DeliveryState`). |
| **Mensajes (Envío)** | `POST /api/chats/:chatId/messages` | `POST /api/v1/conversations/{id}/messages` | Se añade soporte de `Idempotency-Key` y control de versión optimista (`expectedConversationVersion`). La ruta legacy se conserva intacta mediante adaptador. |
| **Toma de Control (Handoff)** | `POST /api/conversations/:id/handoff` | `POST /api/v1/conversations/{id}/takeover` | Se unifica bajo semántica Compare-And-Swap (CAS) con `expectedVersion` para prevenir sobreescrituras concurrentes entre operadores humanos e IA. |
| **Pausa de IA** | `POST /api/ia-pause/:chatId/pause` | `POST /api/v1/conversations/{id}/pause-ai` | La ruta legacy requería resolver el JID `chatId` por SQL con `ANY(...)`; el contrato v1 opera sobre el recurso interno `id`, con `expectedVersion` y `durationSeconds`. |
| **Conexiones de Canal** | `GET /api/whatsapp/status` | `GET /api/v1/channel-connections` | Se generaliza a soporte omnicanal (WhatsApp Cloud, Instagram, Messenger, Telegram) redactando secretos del proveedor. |
| **Diagnóstico de Canal** | N/A (propietario por ruta) | `POST /api/v1/channel-connections/{id}/validate` | Permite verificar estado y credenciales sin registrar mensajes ficticios en clientes reales. |
| **Grafos de Agentes** | `POST /api/agents` | `POST /api/v1/agent-graphs` | Soporte para definición estructurada de nodos (`NodeKind`), aristas condicionales y límites operativos (`limits`). |
| **Validación de Grafo** | N/A | `POST /api/v1/agent-graphs/{id}/validate` | Linter estático que detecta referencias huérfanas o loops sin límites de pasos antes de publicar. |
| **Publicación Inmutable** | `PUT /api/agents/:id` | `POST /api/v1/agent-graphs/{id}/publish` | Genera `specHash` inmutable; los runs en curso no sufren mutaciones de versión en caliente. |
| **Simulador Sandbox** | N/A | `POST /api/v1/agent-runs/simulate` | Dry-run hermético que ejecuta el flujo lógico sin mutaciones en base de datos ni llamadas salientes a APIs de mensajería. |
| **Traza de Ejecución** | `/api/conversations/:id/timeline` | `GET /api/v1/agent-runs/{id}/trace` | Devuelve timeline auditado con `detailsRedacted` para cumplir estándares de privacidad. |
| **Aprobaciones (Cola)** | N/A | `GET /api/v1/approvals` | Cola de acciones de alto riesgo pendientes de aprobación humana según roles de tenant. |
| **Aprobaciones (Decisión)** | N/A | `POST /api/v1/approvals/{id}/decision` | Decisión atómica (approved/rejected) con `Idempotency-Key` y `expectedVersion`. |
| **Operaciones** | N/A | `GET /api/v1/operations/executions` | Historial de soporte técnico, actividades duraderas y reintentos. |

---

## 3. Mapeo de Identificadores y Persistencia

| Concepto Canónico (v1) | Persistencia Existente (PostgreSQL) | Regla de Transformación |
|---|---|---|
| `tenantId: string` | `company_id: integer` | Conversión numérica `parseInt(tenantId, 10)`. En migraciones futuras se mantiene `company_id` como clave primaria de aislamiento RLS. |
| `connectionId: string` | `channel_connections.id` (PR-05) o fallback `defaultConnectionId` | En el estado previo a PR-05, el bridge inyecta una conexión sintética representativa de la cuenta activa sin romper llamadas. |
| `externalConversationId: string` | `external_conversation_id: varchar` | En WhatsApp, almacena el número normalizado o JID (`573001234567`); en Telegram, el chat ID numérico; en Instagram/Messenger, el thread o PSID. |
| `externalIdentityId: string \| null` | `contacts.external_contact_id` | Identificador único del remitente en el canal correspondiente. |
| `stateVersion: number` | `conversations.state_version` (o derivado de contador) | Concurrencia optimista CAS. Si la versión esperada no coincide, el servidor emite `409 Conflict`. |
| `deliveryState: DeliveryState` | `messages.delivery_state` o `message_statuses.status` | Mapeo normalizado: `sent` -> `dispatched`, `delivered` -> `delivered`, `read` -> `read`, `failed` -> `failed`. |

---

## 4. Estrategia de Adaptadores de Transición

Siguiendo el requerimiento explícito:
> *"No cambies los controladores productivos ni las migraciones actuales. Conserva los contratos existentes mediante adaptadores cuando corresponda."*

Se diseñaron dos adaptadores aislados en `packages/contracts/src/adapters`:

### 4.1 `LegacyChannelAdapterBridge`
Permite a cualquier componente que requiera la interfaz `ChannelAdapterV1` utilizar una instancia existente de `MessageChannelPort` (como `WhatsappWebAdapter` o el conector Meta actual):
- **Traducción de Inbound**: Mapea headers de transporte HTTP a resolución de conexión.
- **Traducción de Envíos**: Convierte `SendMessageCommandV1` en `OutboundMessageRequestDTO`, delega en `legacyPort.sendMessage(...)` y traduce el `SendResult` resultante a `SendMessageResultV1` con estados tipados (`DeliveryState`).
- **Diagnóstico de Salud**: Mapea `legacyPort.getStatus()` a `ChannelConnectionHealthV1`.

### 4.2 `LegacyConversationMapper`
Funciones puras de mapeo entre estructuras DTO legacy y contratos canónicos:
- `mapLegacyInboundToCanonicalEvent`: Genera eventos `ChannelEventV1` válidos frente a esquema a partir de un `InboundMessageDTO`.
- `mapCanonicalCommandToLegacyOutbound`: Transforma comandos de salida v1 en peticiones compatibles con el despachador de mensajería actual.
- `mapLegacyStatusToCanonicalEvent`: Transforma actualizaciones de estado en eventos de canal con discriminante `message.status`.
- `mapLegacyConversationToCanonical`: Mapea registros de conversación existentes al contrato `ConversationV1`.
- `mapLegacyContactToCanonicalIdentity`: Mapea contactos existentes a identidades de canal `ChannelIdentityV1` asegurando la regla de no mezclar personas cross-canal sin autorización explícita.

---

## 5. Validación de Pruebas y Tipos

La suite de pruebas fue ejecutada y validada en el entorno del worktree:

1. **`packages/contracts`**:
   - `npm run build`: `tsc` genera exitosamente declaraciones `.d.ts` y bundles en `dist/` con modo estricto.
   - `npm run typecheck`: 0 errores de TypeScript (`tsc --noEmit`).
   - `npm test`: **64 contract tests superados al 100%** (0 fallos, 0 omitidos, duración ~834 ms).
2. **`WhatsaapWeb-JS` (Regresión del backend existente)**:
   - `npm run typecheck`: 0 errores.
   - `npm test`: **45 pruebas preexistentes superadas al 100%** (webhook Meta P0, routing multiagente, handoff idempotency, safe runtime, etc.).
3. **`Frontend_py_whatsaapweb` (Regresión del frontend existente)**:
   - `npm run build`: Compilación exitosa con Vite y TypeScript (`tsc -b && vite build`), 0 errores de tipado.

---

## 6. Dependencias y Reglas de Desarrollo Paralelo

Conforme a las reglas de trabajo simultáneo entre agentes de Antigravity:

| PR Relacionado | Estado Asumido | Interfaz / Integración en PR-04 | Conflicto Potencial / Mitigación |
|---|---|---|---|
| **PR-00** (Baseline, CI) | No asumido como fusionado. | `packages/contracts` opera de forma autónoma con su propio `package.json` y scripts. | Cero colisiones en archivos de producto. El CI de PR-00 podrá agregar `packages/contracts` sin cambios destructivos. |
| **PR-01** (Auth JWT) | En desarrollo paralelo. | Los contratos OpenAPI y esquemas definen la cabecera `Authorization: Bearer <token>` y el modelo `TenantActor` (`tenantId`, `userId`, `roles`). | No se modificó `WhatsaapWeb-JS/src/middleware/jwtAuth.ts` ni `app.ts`. PR-01 consumirá `TenantActor` o validará claims coincidentes. |
| **PR-02** (Socket.IO Rooms) | No iniciado (espera PR-01). | Definición contractual de eventos en tiempo real `ServerEventV1` y nombres de room canónicos `AuthorizedRoom` (`tenant:*`, `conversation:*:*`, `user:*:*`). | No se modificó `socketHandler.js` ni `socketEmitter.ts`. PR-02 podrá adoptar directamente los tipos de `packages/contracts`. |
| **PR-03** (Tenant Audit & RLS) | No iniciado. | Contratos desacoplados de tablas físicas mediante interfaces; mapeo de `tenantId` a `companyId` documentado. | No se crearon ni alteraron migraciones SQL. PR-03 se encargará exclusivamente de `022_` y RLS. |
| **PR-05** (Channel Connection Registry) | Depende de PR-04. | Contratos de `ChannelConnectionV1`, `ChannelIdentityV1`, y puerto `ChannelAdapterV1` listos para ser implementados por los adaptadores de canal. | PR-05 utilizará `packages/contracts` como fuente de verdad para registrar conexiones de Meta y otros canales. |
| **PR-08** / **PR-09** (Temporal & Agent Graphs) | Dependen de PR-04. | Contratos de `AgentGraphVersionV1`, `ToolInvocationV1`, `AgentRunTraceV1` y `ApprovalRequestV1` congelados con validación Zod. | PR-09 podrá compilar directamente los grafos contra estos esquemas. |

---

## 7. Plan de Rollback

Dado que **PR-04 no modifica controladores productivos, migraciones de base de datos ni componentes de usuario preexistentes**, el rollback es completamente seguro y aislado:
1. Revertir la rama `implement_shared_contracts_pr04` o eliminar la carpeta `packages/contracts` y `docs/api`.
2. Las aplicaciones existentes (`WhatsaapWeb-JS` y `Frontend_py_whatsaapweb`) continúan funcionando sin interrupción ni dependencia forzada.
