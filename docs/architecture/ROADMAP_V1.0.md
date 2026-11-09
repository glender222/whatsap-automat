# WhatsApp Automat — Roadmap de Implementación Técnica a Producción (Blueprint v1.0)

**Versión:** 1.0.0 — Baseline de Implementación Aprobado para Planificación  
**Fecha:** 2026-11-01  
**Estado:** PLAN MAESTRO NORMATIVO · APROBACIÓN PREVIA REQUERIDA (CERO MODIFICACIONES DE CÓDIGO)  
**Rama Base de Integración:** `integration/v0.4-consolidated` (Commit `0d9542e`)  
**Rama Main Intacta:** `main` (Commit `69ac388`)  
**Autor:** Equipo de Arquitectura e Integración Técnica Whatsap-Automat  
**Especificación Normativa de Referencia:** `WHATSAP_AUTOMAT_PRODUCT_ARCHITECTURE_BLUEPRINT_V1.0.md`  

---

## 1. Resumen Ejecutivo y Contexto de la Línea Base de Integración

El presente documento establece el **Plan Maestro de Implementación Técnica a Producción** para Whatsap-Automat conforme al *Product & Architecture Blueprint v1.0*. La visión estratégica de producto evoluciona la plataforma desde un sistema centrado exclusivamente en mensajería hacia una **plataforma empresarial omnicanal, auto-hospedada, de código abierto (licencia MIT) y extensible para operaciones conversacionales y automatización inteligente de procesos de negocio con o sin canales (UC-06)**.

### 1.1 Estado de la Línea Base (`integration/v0.4-consolidated`)
La rama de integración consolidada se encuentra verificada y estabilizada en el commit `0d9542e`, habiendo integrado con éxito los hitos fundacionales M0 a M5:
- **PR-00 (`baseline_reproducible_pr_zero`):** Configuración determinista de entornos monorepo y CI.
- **PR-01 (`fix_jwt_auth_p0`):** Autenticación JWT fail-closed en REST y resolución estricta de tenant.
- **PR-04 (`implement_shared_contracts_pr04`):** Creación del paquete `@whatsap-automat/contracts` con tipado estricto Zod.
- **PR-07 (`implement_temporal_spike_pr07`):** Validación empírica de orquestación duradera con Temporal OSS en `spikes/temporal/`.
- **Auditoría QA y Seguridad (`comprehensive_qa_security_audit`):** 18 pruebas de regresión de aislamiento directo en SQL en `security-mitigations.test.ts`.
- **Auditoría y Prototipos UX (`ux_ui_unified_workspace_design`):** 5 documentos de diseño y 4 prototipos TSX en `docs/ux/`.

### 1.2 Métrica Global de Calidad
- **Total de pruebas automatizadas en monorepo:** **163 pruebas ejecutadas, 163 pruebas exitosas (100% PASS), 0 fallas**.
  - `packages/contracts`: 64/64 PASS (10 suites, 0 ms network, tsc limpio).
  - `WhatsaapWeb-JS`: 94/94 PASS (12 suites, tsc y tsc:scripts limpios).
  - `spikes/temporal`: 5/5 PASS (4 suites, durabilidad con muerte abrupta de workers, replay y timers).
  - `Frontend_py_whatsaapweb`: Compilación limpia con Vite (`tsc -b && vite build`) en 14.55s.
- **Integridad de Git:** La rama `main` permanece **rigurosamente intacta** en el commit `69ac388`. Ningún cambio de código de aplicación ha sido introducido en esta etapa de planificación.

---

## 2. R1: Matriz Exhaustiva de Análisis de Brechas (Gap Analysis)

Para dar cumplimiento riguroso y verificable al requerimiento **R1**, la presente sección contrasta de manera exhaustiva la totalidad de los componentes definidos en el *Product & Architecture Blueprint v1.0* frente a lo implementado físicamente en la rama base `integration/v0.4-consolidated` (commit `0d9542e`). 

El análisis se estructura en cuatro matrices normativas independientes que cubren el 100% de los identificadores del proyecto (**83 ítems en total**):
1. **Entregables de Backlog Técnico de Arquitectura:** `WAA-001` a `WAA-028` (28 entregables).
2. **Requerimientos de Producto Normativos:** `PROD-001` a `PROD-019` (19 requerimientos).
3. **Controles de Seguridad y Gobernanza:** `SEC-001` a `SEC-012` (12 controles).
4. **Decisiones de Arquitectura:** `ADR-001` a `ADR-024` (24 decisiones).

---

### 2.1 Matriz de Entregables de Backlog Técnico (`WAA-001` a `WAA-028`)

| Identificador | Dimensión / Entregable Target (Blueprint v1.0 §12.3) | Estado Actual en Repositorio (`integration/v0.4-consolidated`) | Clasificación | Brecha Técnica y Acción Requerida | Fase Asignada |
|---|---|---|---|---|---|
| **WAA-001** | Integración auditada de F0 y consolidación de CI monorepo determinista | Integrado en `integration/v0.4-consolidated` (PR-00..07, QA, UX/UI). CI verde. | **Implementado** | Preservar suites y scripts sin modificaciones; mantener monorepo determinista. | **F0 (DONE)** |
| **WAA-002** | Handshake Socket.IO con JWT fail-closed y rooms aisladas por tenant (`tenant:${id}`) | `WhatsaapWeb-JS/src/sockets/socketHandler.js` no valida JWT, emite eventos globales y permite joins anónimos. | **Riesgo Crítico P0 / Ausente** | Reescribir manejador en TypeScript con `io.use(socketJwtAuth)`, rooms autorizadas y sin broadcasts globales. | **F1** |
| **WAA-003** | PostgreSQL Row-Level Security (RLS) en todas las tablas tenant y `TenantScopedUoW` transaccional | Migraciones 000–021 sin RLS a nivel de motor. Aislamiento mitigado en capa de app por `resourceAuth.ts`. | **Ausente a nivel BD** | Crear migración `022_enable_rls.sql`, definir rol sin BYPASSRLS y `TenantScopedUoW` en pool de conexiones. | **F1** |
| **WAA-004** | Jerarquía de Tenancy: `Tenant` -> `Workspace` -> `company_id` legacy | BD usa exclusivamente `company_id integer`. Contratos usan `tenantId`. Entidad `Workspace` ausente. | **Parcialmente Implementado** | Crear tablas `tenants`, `workspaces` y `memberships`. Mapear `company_id` como alias de compatibilidad. | **F1** |
| **WAA-005** | Envoltorio Canónico CloudEvents (`CanonicalEventV1`) para todos los canales e integraciones | `packages/contracts` contiene `ChannelEventV1`. Falta formato CloudEvents 1.0, causación y correlation ID. | **Parcialmente Implementado** | Extender contratos a `CanonicalEventV1` (specversion 1.0, source, type, datacontenttype, correlation_id, causation_id). | **F2** |
| **WAA-006** | Registro dinámico de capacidades de canales (`CapabilityRegistry`) con evaluación en 6 dimensiones | Interfaz básica `getCapabilities` en `contracts`. Sin persistencia de snapshots ni evaluación dinámica. | **Parcialmente Implementado** | Implementar `CapabilityRegistry` en backend, almacenamiento de snapshots y validador de políticas previo a publish. | **F2** |
| **WAA-007** | Patrón Outbox Transaccional (`ProcessingOutbox`), dedupe en ingreso y estado `delivery_unknown` | Ingestión webhook responde directamente sin outbox persistente. No existe tabla `processing_outbox` en BD. | **Ausente en Backend** | Implementar migración de tabla `processing_outbox`, persistencia atómica evento+outbox y ledger de idempotencia. | **F2** |
| **WAA-008** | Control de Concurrencia CAS y `ownership_epoch` para transferencia Humano <-> IA | Comandos CAS definidos en `contracts`. Tabla `conversations` en BD no tiene columnas `version` ni `ownership_epoch`. | **Parcialmente Implementado** | Añadir columnas `version` y `ownership_epoch` a `conversations` e implementar actualización CAS atómica en backend. | **F3** |
| **WAA-009** | Adaptador Meta Cloud API oficial y Triggers Sociales de Instagram (Comments, Mentions, DM) | Cliente Meta básico en `src/services/whatsapp/meta`. Sin soporte de Instagram Graph API ni eventos sociales. | **Parcialmente Implementado** | Implementar `MetaCloudAdapter` unificado para WhatsApp e Instagram con gestión de comentarios y reply privado. | **F3** |
| **WAA-010** | Adaptador Telegram Bot API y Widget de Webchat auto-hospedado | Fixtures sintéticas en `contracts`. Sin adaptadores funcionales en backend de `WhatsaapWeb-JS`. | **Parcialmente Implementado** | Implementar `TelegramBotAdapter` y `WebchatAdapter` (SSE/WebSocket) cumpliendo `ChannelAdapterV1`. | **F3** |
| **WAA-011** | Orquestación Duradera con Temporal OSS, revisiones inmutables de workflows y rollback atómico | Spike validado en `spikes/temporal/` (5/5 tests). Backend principal no tiene dependencias ni workers conectados. | **Parcialmente Implementado** | Conectar daemon de relay `processing_outbox -> Temporal Client`, implementar workflows inmutables y rollback. | **F4** |
| **WAA-012** | Runtime de Agentes IA, ModelGateway neutral (BYOK/local) y barrera de seguridad `ToolBroker` | Runtime básico en `AgentToolRuntimeLoop.ts`. Tools se ejecutan sin validación externa de SSRF ni RBAC. | **Parcialmente Implementado** | Crear capa `ToolBroker` con filtro SSRF (RFC 1918), autorización server-side, presupuesto de tokens y aprobaciones HITL. | **F5** |
| **WAA-013** | Agent Studio (Vistas Guided y Advanced), RAG aislado por tenant y evaluador de regresión | Prototipo conceptual en `docs/ux/prototypes/agent-graph-spec.tsx`. UI legacy básica en `AgentsPage.tsx`. | **Parcialmente Implementado** | Construir Agent Studio multinivel, indexación vectorial con `pgvector` por tenant y simulador de evaluaciones. | **F5** |
| **WAA-014** | Automation Studio (Canvas visual DAG + Outline sincronizado) y flujos de negocio sin canal (UC-06) | Inexistente en backend y frontend. El sistema actual solo soporta respuestas reactivas acopladas a WhatsApp. | **Ausente** | Implementar editor de grafos DAG en frontend, motor de validación de esquemas y ejecución de triggers webhook/cron. | **F4** |
| **WAA-015** | Inbox Omnicanal Unificado como Sistema de Trabajo (4 paneles: Nav, Queue, Chat, Context) | UI legacy acoplada a chat simple. Prototipo TSX completo en `docs/ux/prototypes/omnichannel-inbox-spec.tsx`. | **Parcialmente Implementado** | Reemplazar vista de Inbox en React conectando el prototipo de 4 paneles con datos reales y badges de SLA. | **F3** |
| **WAA-016** | Motor de Campañas, Segmentación Dinámica y Verificación Estricta de Consentimiento (`ConsentRecord`) | Sin modelos ni lógica en backend o frontend para campañas o listas de supresión. | **Ausente** | Crear tablas `consent_records`, `segments`, `campaigns`. Implementar validador de opt-in y despachador throttled. | **F6** |
| **WAA-017** | Adaptador de Canal Email (SMTP saliente / IMAP entrante con threading) | Sin soporte de correo electrónico en backend. | **Ausente** | Desarrollar `EmailAdapter` con parsing MIME, vinculación a hilos de conversación y soporte TLS/DKIM. | **F6** |
| **WAA-018** | API REST Pública Contract-First v1 con OpenAPI, SDK TypeScript oficial y webhooks salientes firmados | Contratos internos en `packages/contracts`. Sin especificación OpenAPI pública expuesta ni webhooks firmados. | **Parcialmente Implementado** | Publicar `@whatsap-automat/contracts` y `@whatsap-automat/sdk`. Implementar despacho de webhooks HMAC-SHA256. | **F7** |
| **WAA-019** | Sistema de Diseño "Automat UI" (Foundations, Primitives, Components, WCAG 2.2 AA) | Prototipos y tokens definidos en `docs/ux/` (`04_SISTEMA_DISENO_Y_TOKENS.md`). Frontend real no consume los tokens. | **Parcialmente Implementado** | Integrar paquete de tokens semánticos en `Frontend_py_whatsaapweb` y configurar soporte dark/high-contrast. | **F2** |
| **WAA-020** | Asistente de Conexión de Canales y Herramienta Diagnóstica de Salud (`doctor` CLI/UI) | Diagnósticos ad-hoc no estandarizados en scripts legacy. | **Ausente** | Implementar comando `automat doctor` y pantalla de diagnóstico con códigos resolutivos (`CH-<CHAN>-<NUM>`). | **F8** |
| **WAA-021** | Plataforma de Extensiones, Sandboxing de Procesos/WASI y Slots de UI en Iframes Seguros | Inexistente. Todas las integraciones son monolíticas dentro de `WhatsaapWeb-JS`. | **Ausente** | Implementar Host de Extensiones en subprocesos aislados y runtime de iframes sandboxed con postMessage RPC. | **F7** |
| **WAA-022** | Automatización de Respaldo, Restauración Verificada y Ensayos de Desastre | Procedimientos manuales no verificados en CI/CD. | **Ausente** | Crear scripts automatizados de snapshot PostgreSQL + blobs S3 con verificación de restore en contenedor limpio. | **F8** |
| **WAA-023** | Hardening Empresarial: RBAC granular, SSO/OIDC, pistas de auditoría append-only y cifrado de secrets | `audit_events` no implementado. Secrets de proveedores en texto plano en BD. RBAC básico en tokens. | **Parcialmente Implementado** | Cifrado KMS/AES-256-GCM para credenciales, tabla append-only `audit_events` y conector SSO OpenID Connect. | **F8** |
| **WAA-024** | Auditoría de Licencias (100% MIT), SBOM y Verificación de Distribución Community Edition | Licencia raíz MIT. Requiere verificación estricta de dependencias npm para evitar contaminación AGPL. | **Implementado conceptualmente** | Incorporar escáner de licencias en CI (`license-checker`) y generador de SBOM CycloneDX. | **F8** |
| **WAA-025** | Auditoría técnica y legal de hipótesis de terceros (ChatbotX / Flowise / Activepieces) | Documentado como hipótesis exploratoria en SRC-A y Blueprint v1.0. | **Pendiente de Auditoría** | Ejecutar análisis estricto de viabilidad antes de incorporar cualquier código externo al núcleo MIT. | **F8** |
| **WAA-026** | Adaptadores de Expansión Omnicanal: TikTok Business Messaging y LINE Official Account | Inexistente. | **Planificado (P3)** | Implementar adaptadores cumpliendo la especificación `ChannelAdapterV1`. | **F9** |
| **WAA-027** | Clientes Móviles Nativos para Android e iOS (React Native / Expo) enfocados en Inbox Operativo | Inexistente. Desacoplado del camino crítico de la web empresarial para evitar bloqueos de lanzamiento. | **Planificado (P3)** | Desarrollar aplicación React Native consumiendo `@whatsap-automat/sdk` y Socket.IO con push notifications. | **F9** |
| **WAA-028** | SDK Oficial en Python y Registro Público de Extensiones / Marketplace Comunitario | Inexistente. | **Planificado (P3)** | Generar cliente Python tipado y catálogo centralizado de conectores verificados por la comunidad. | **F9** |

---

### 2.2 Matriz de Requerimientos de Producto Normativos (`PROD-001` a `PROD-019`)

| Identificador | Requisito Normativo (Blueprint v1.0 §2.3) | Criterio de Verificación Mínima | Estado Actual en Repositorio (`integration/v0.4-consolidated`) | Clasificación | Brecha Técnica y Acción Requerida | Fase Asignada |
|---|---|---|---|---|---|---|
| **PROD-001** | Misma instalación opera workflows con o sin canales | UC-06 E2E sin conexión de canal | Inexistente en backend/frontend. Workflows acoplados exclusivamente a WhatsApp. | **Ausente** | Implementar triggers universales (Webhook/Cron) en Automation Studio y motor desacoplado de canales (UC-06). | **F4** |
| **PROD-002** | UI por dominios Operations/Automation/Platform/Administration | Navegación y permission tests | UI legacy sin separación formal por dominios; diseño unificado definido en prototipos de `docs/ux/`. | **Parcialmente Implementado** | Implementar Shell de navegación con los 4 dominios y control de acceso por roles. | **F3** |
| **PROD-003** | Toda conversación tiene tenant, identity, ownership y timeline | Test migración/invariantes | Tabla `conversations` usa `company_id`, sin soporte formal de `tenantId`, `ownership_epoch` ni timeline. | **Parcialmente Implementado** | Migración de esquema en `conversations` añadiendo `tenant_id`, `ownership_epoch`, `version` e historial unificado. | **F3** |
| **PROD-004** | Acciones/activadores por capacidades reales de conexión | Publish gate bloquea acción ausente | `contracts` define interfaces base; backend no evalúa capacidades antes de publish o ejecución. | **Parcialmente Implementado** | Integrar validador pre-publish en `CapabilityRegistry` que bloquee flujos con acciones no soportadas por la conexión. | **F2** |
| **PROD-005** | Handoff humano/IA consistente, versionado | Race test para takeover | Comandos CAS en `@whatsap-automat/contracts`; falta persistencia y validación atómica en backend. | **Parcialmente Implementado** | Mutaciones CAS atómicas (`UPDATE ... WHERE version = :expected`) con fencing `ownership_epoch` y test de concurrencia. | **F3** |
| **PROD-006** | Workflows y agentes draft/test/published + rollback | Run activo no cambia tras editar draft | Spike Temporal valida inmutabilidad; backend carece de entidad `workflow_revisions`. | **Parcialmente Implementado** | Crear tabla `workflow_revisions` inmutable; vinculación de ejecuciones al ID publicado y rollback instantáneo. | **F4** |
| **PROD-007** | Campañas básicas con consentimiento y cuotas | Intento sin opt-in rechazado cuando exigible | Inexistente en monorepo. Sin campañas, listas de supresión ni cuotas. | **Ausente** | Crear tablas `campaigns`, `segments`, `consent_records`; validador pre-envío que rechace mensajes sin opt-in o fuera de ventana. | **F6** |
| **PROD-008** | Developer API con OpenAPI y webhooks firmados | Conformance contra servidor real | Contratos Zod en `packages/contracts`; sin OpenAPI público expuesto ni webhook dispatcher HMAC. | **Parcialmente Implementado** | Exponer API v1 documentada en OpenAPI; despachador de webhooks con firma HMAC-SHA256 y timestamping. | **F7** |
| **PROD-009** | LLM BYOK + endpoint compatible/local | Mismo agente con dos providers | Invocación directa acoplada en `AgentToolRuntimeLoop.ts`. Sin abstracción multi-proveedor ni endpoints locales. | **Parcialmente Implementado** | Construir `ModelGateway` neutral server-side; soporte BYOK (OpenAI/Anthropic) y endpoints locales (Ollama/vLLM). | **F5** |
| **PROD-010** | No se requieren servidores propietarios del fabricante | Fresh self-host sin vendor account | Verificado en baseline `integration/v0.4-consolidated`. Cero dependencias cloud obligatorias; corre 100% local. | **Implementado** | Preservar soberanía local; auditar que ningún módulo introduzca telemetría obligatoria o dependencia SaaS cerrada. | **F0 (DONE)** |
| **PROD-011** | Instalación incluye funciones CE esenciales | Prueba smoke sin licencia externa | Núcleo opera localmente, pero falta prueba smoke automatizada que certifique CE sin licencias externas. | **Parcialmente Implementado** | Incorporar suite smoke E2E en CI que levante la plataforma completa en contenedor limpio sin licencias comerciales. | **F8** |
| **PROD-012** | Inventario verificable de capacidades por canal/conexión | Contract suite independiente | Interfaz `getCapabilities` tipada en `contracts`; sin registro persistente ni suite de tests independiente. | **Parcialmente Implementado** | Construir `CapabilityRegistry` en backend y suite de pruebas independiente por conexión en `packages/contracts`. | **F2** |
| **PROD-013** | Routing por colas, disponibilidad, skills/prioridades configurables | Fixtures reproducibles | Chat simple sin colas formales, sin skills de agentes y sin control de estados de disponibilidad. | **Ausente** | Desarrollar motor de enrutamiento en backend por colas de trabajo, matriz de habilidades y fixtures deterministas. | **F3** |
| **PROD-014** | Diagnóstico y replay autorizados | `doctor`/UI con evidencia redactada | Diagnósticos ad-hoc no estandarizados en scripts legacy. | **Ausente** | Implementar comando CLI `automat doctor` y pantalla de diagnóstico en UI con códigos resolutivos (`CH-<CHAN>-<NUM>`). | **F8** |
| **PROD-015** | Backups, upgrades y restores guiados | Restore rehearsal | Procedimientos manuales no automatizados ni testeados en CI. | **Ausente** | Crear scripts automatizados de snapshot PostgreSQL + blobs y suite de rehearsal en CI en contenedor aislado. | **F8** |
| **PROD-016** | SDKs y extensiones de terceros con compatibilidad | Extensión externa pasa CI | Inexistente en monorepo. No hay soporte para plugins de terceros. | **Ausente** | Diseñar SDK de extensiones con SemVer estricto, interfaces estables y prueba en CI con una extensión de ejemplo. | **F7** |
| **PROD-017** | Auditoría, políticas, métricas y límites por tenant | Pruebas adversariales | Aislamiento en app layer (`resourceAuth.ts`); faltan cuotas LLM por tenant, rate limits y métricas auditables. | **Parcialmente Implementado** | Implementar medidor de consumo de tokens por tenant en `ToolBroker`/`ModelGateway`, ledger de costos y cuotas en BD. | **F5** |
| **PROD-018** | Android/iOS instalables con operaciones prioritarias | E2E dispositivos; alcance del v0.4 | Inexistente. Solo aplicación web React. | **Planificado (P3)** | Desarrollar aplicación React Native / Expo optimizada para inbox, triage y notificaciones push. | **F9** |
| **PROD-019** | Marketplace y Python SDK maduro | Suite cross-SDK/registry | Inexistente. | **Planificado (P3)** | Implementar SDK oficial tipado en Python (`whatsap-automat-sdk`) y catálogo de extensiones comunitarias verificadas. | **F9** |

---

### 2.3 Matriz de Controles de Seguridad y Gobernanza (`SEC-001` a `SEC-012`)

| Identificador | Control de Seguridad (Blueprint v1.0 §10.1) | Gate Obligatorio | Estado Actual en Repositorio (`integration/v0.4-consolidated`) | Clasificación | Brecha Técnica y Acción Requerida | Fase Asignada |
|---|---|---|---|---|---|---|
| **SEC-001** | JWT fail-closed REST + sockets; sin tenant default | Tests anon/no tenant token rechazados | REST fail-closed asegurado en `jwtAuth.ts` (PR-01); Sockets en `socketHandler.js` son anónimos e inseguros. | **Riesgo Crítico P0 / Parcial** | Implementar middleware `io.use(socketJwtAuth)`, rechazo fail-closed sin token válido o sin tenant. | **F1** |
| **SEC-002** | Tenant isolation API, storage, search, realtime, RLS | Cross-tenant fuzz/integration 0 escapes | Aislamiento mitigado en consultas manuales en Node.js; base de datos sin RLS en PostgreSQL. | **Ausente en BD / Crítico P0** | Habilitar PostgreSQL Row-Level Security en tablas con columna `tenant_id`, crear rol de runtime sin BYPASSRLS. | **F1** |
| **SEC-003** | Recursos autorizados desde SQL por tenant, no post-filtering | IDOR fixtures, query plan y negative tests | Implementado en `resourceAuth.ts` para endpoints auditados; requiere generalización mediante `TenantScopedUoW`. | **Parcialmente Implementado** | Formalizar `TenantScopedUoW` transaccional con `SET LOCAL app.current_tenant_id` garantizado en cada conexión. | **F1** |
| **SEC-004** | Roles y permisos server-side + ownership CAS | Tool/route/socket no autorizado 403 | Roles básicos en token JWT; falta validación granular de permisos por ruta y control de pertenencia CAS. | **Parcialmente Implementado** | Implementar guardas RBAC server-side en rutas y eventos de socket, y control CAS en mutaciones conversacionales. | **F3** |
| **SEC-005** | Firma, timestamp y dedupe de webhooks | Falso/replay webhook rechazado | Ingestión directa en controladores sin verificación de firma HMAC uniforme ni deduplicación temporal. | **Ausente** | Middleware unificado de verificación de firmas HMAC y timestamp (tolerancia máx. 300s); deduplicación atómica en outbox. | **F2** |
| **SEC-006** | Secret storage cifrado y rotación, no logging | Tests de API/log/backup y restore key | Variables de entorno en texto plano; tokens de WhatsApp/Meta almacenados sin cifrado a nivel de fila. | **Ausente** | Crear `SecretVault` con cifrado envelope AES-256-GCM o KMS, enmascaramiento en logs y scripts de rotación de llaves. | **F8** |
| **SEC-007** | ToolBroker y SSRF/network egress | Blocked private IP/tool privilege escalation | Ejecución directa de tools en `AgentToolRuntimeLoop.ts` sin filtrado de IP ni RBAC. | **Ausente / Riesgo Alto** | Implementar barrera `ToolBroker` con bloqueo estricto de rangos privados RFC 1918/RFC 4193/link-local y RBAC por tool. | **F5** |
| **SEC-008** | Campaign compliance: opt-in, window, template, unsub | Envío prohibido rechazado antes de proveedor | Inexistente en monorepo. | **Ausente** | Validador estricto previo a despacho en `CampaignDispatcher` que garantice opt-in explícito y respete la ventana de 24h. | **F6** |
| **SEC-009** | Plugin isolation y manifest scopes | Plugin hostil no lee secretos/files de core | Inexistente. | **Ausente** | Sandboxing de plugins en subprocesos con permisos reducidos o WASI; iframes en frontend con atributos sandbox restringidos. | **F7** |
| **SEC-010** | Backups, restore, upgrade y rollback | Ensayo automatizado en ambiente aislado | Manual y no probado. | **Ausente** | Script automatizado de backup y pipeline en CI de rehearsal que restaure en base de datos temporal y valide integridad. | **F8** |
| **SEC-011** | Audit append-only y retención configurable | Eventos críticos auditados + integrity review | Sin tabla de auditoría formal; logs de aplicación en stdout sin garantía append-only. | **Ausente** | Crear tabla `audit_events` inmutable con triggers que impidan UPDATE/DELETE y política de retención configurable. | **F8** |
| **SEC-012** | Integridad de dependencias/licencias | SBOM, scanning, CE build sin imports EE | Licencia MIT en raíz. Falta escáner formal de dependencias en CI y validación de distribución CE limpia. | **Parcialmente Implementado** | Pipeline de CI con CycloneDX SBOM, auditoría de vulnerabilidades con `audit-ci` y verificación de compatibilidad de licencias. | **F8** |

---

### 2.4 Matriz de Decisiones Arquitectónicas (`ADR-001` a `ADR-024`)

| Identificador | Tema y Decisión Normativa (Blueprint v1.0 §13) | Estado Normativo | Estado Actual en Repositorio (`integration/v0.4-consolidated`) | Clasificación | Brecha Técnica y Acción Requerida | Fase Asignada |
|---|---|---|---|---|---|---|
| **ADR-001** | Límites de producto: conversación y negocio comparten event/runtime, no ERP/CRM completo | PROPUESTO | Acoplado a WhatsApp; límites conceptuales definidos en Blueprint v1.0. | **Propuesto / Normativo** | Establecer frontera clara: Whatsap-Automat provee orquestación y mensajería sin reimplementar un CRM/ERP monolítico. | **F0 / F4** |
| **ADR-002** | Modelo tenant/workspace/company: mapping único y RLS sin renombrar legacy por estética | PENDIENTE | BD legacy usa `company_id integer`. Contratos usan `tenantId`. | **Parcialmente Implementado** | Crear tablas `tenants` y `workspaces`, manteniendo `company_id` como alias de persistencia y habilitando RLS. | **F1** |
| **ADR-003** | Arquitectura modular + workers: base TS/Node incremental y puertos explícitos | RETENIDO/PROPUESTO | Monorepo Node/TS consolidado en PR-00..04; spike de worker temporal en `spikes/temporal`. | **Implementado en Línea Base** | Preservar Express en backend productivo; formalizar arquitectura hexagonal con puertos explícitos y workers desacoplados. | **F0 / F1** |
| **ADR-004** | Canonical events v1: CloudEvents-like compatible con contracts v0.4 | PENDIENTE | `packages/contracts` contiene `ChannelEventV1`; falta formato formal CloudEvents 1.0 con correlation/causation IDs. | **Parcialmente Implementado** | Crear `CanonicalEventV1` implementando especificación CloudEvents 1.0 manteniendo compatibilidad con contratos v0.4. | **F2** |
| **ADR-005** | Adapter Channel + capability/policy: acciones diferenciadas por API/scopes/estado | PROPUESTO | Interfaz `ChannelAdapterV1` en contracts; falta evaluación de capacidades dinámicas en runtime. | **Parcialmente Implementado** | Implementar motor de resolución de capabilities y políticas conversacionales por canal en `WhatsaapWeb-JS`. | **F2** |
| **ADR-006** | Durable execution + Temporal: spike -> bridge validado y no code-path síncrono | RETENIDO/PROPUESTO | Validado exitosamente en `spikes/temporal/` (5/5 pruebas). No integrado al backend principal. | **Validado en Spike** | Conectar daemon relay `processing_outbox -> Temporal Client`, garantizando ejecución duradera fuera del request síncrono. | **F4** |
| **ADR-007** | Idempotency & delivery unknown: una acción lógica, no garantía falsa de envío físico | PROPUESTO | Ingestión responde síncronamente sin outbox. | **Ausente en Backend** | Crear tabla `processing_outbox` con clave de idempotencia transaccional y estado `delivery_unknown` para fallos intermedios. | **F2** |
| **ADR-008** | Conversational ownership CAS: humano/IA takeover con versión y fencing | RETENIDO/EXTENDER | Comandos definidos en `@whatsap-automat/contracts`. Base de datos sin columnas `version` ni `ownership_epoch`. | **Parcialmente Implementado** | Añadir columnas `version` y `ownership_epoch` a `conversations` y lógica CAS en backend para transferencias deterministas. | **F3** |
| **ADR-009** | Agent graph visual+advanced: mismo grafo versionado con límites operativos | RETENIDO | Prototipo visual TSX en `docs/ux/`; UI legacy simple en frontend. | **Parcialmente Implementado** | Implementar "Agent Studio" con sincronización bidireccional entre vista guiada y vista avanzada de grafo DAG. | **F5** |
| **ADR-010** | Agent vs automation semantics: dos studios integrados, diferentes garantías | PROPUESTO | Conceptos mezclados en código legacy. | **Ausente** | Separar semánticamente "Automation Studio" (DAG determinista vía Temporal) de "Agent Studio" (bucle heurístico autónomo). | **F4 / F5** |
| **ADR-011** | LLM gateway/BYOK/local: proveedor neutral sin credenciales en frontend | RETENIDO | Invocación hardcoded a un solo modelo en runtime básico. | **Parcialmente Implementado** | Implementar `ModelGateway` neutral server-side compatible con OpenAI, Anthropic y modelos locales sin exponer API keys al frontend. | **F5** |
| **ADR-012** | ToolBroker y efectos laterales: autorización server-side, HITL por riesgo | PROPUESTO | Tools se ejecutan sin barrera de seguridad en `AgentToolRuntimeLoop.ts`. | **Ausente / Riesgo de Seguridad** | Crear middleware `ToolBroker` con validación de esquema, mitigación SSRF, autorización RBAC y soporte HITL para herramientas críticas. | **F5** |
| **ADR-013** | Secret management: envelope encryption y key rotation/backups | PROPUESTO | Secrets de integraciones guardados en texto plano en la BD. | **Ausente** | Implementar cifrado envelope con llave maestra protegida (AES-256-GCM / KMS) para tokens y credenciales de canales y proveedores. | **F8** |
| **ADR-014** | Public API/Webhooks/SDK: OpenAPI v1, TS SDK, signatures, SemVer | PROPUESTO | Contratos Zod internos en `packages/contracts`. | **Parcialmente Implementado** | Generar especificación pública OpenAPI v1, publicar SDK TypeScript oficial `@whatsap-automat/sdk` y despachador de webhooks firmados. | **F7** |
| **ADR-015** | Extensiones y runtime sandbox: proceso/contenedor/WASI según capacidades | PENDIENTE | Arquitectura monolítica sin puntos de extensión seguros. | **Ausente** | Implementar host de extensiones desacoplado en subproceso con comunicación IPC restringida y slots de UI mediante iframes con CSP estricto. | **F7** |
| **ADR-016** | UI/Navigation/Design System: cuatro áreas, Automat UI, WCAG 2.2 AA | PROPUESTO | Documentación y prototipos en `docs/ux/`; aplicación React aún con estilos heterogéneos. | **Parcialmente Implementado** | Implementar tokens de diseño de "Automat UI" en frontend e integrar componentes accesibles WCAG 2.2 AA en los 4 dominios. | **F2 / F3** |
| **ADR-017** | Self-hosted deployment: Community independiente; cloud opcional | RETENIDO | Verificado en monorepo local; no depende de infra SaaS propietaria. | **Retenido / Implementado** | Garantizar que la versión Community Edition (CE) pueda desplegarse íntegramente con Docker Compose en hardware propio con soberanía total. | **F8** |
| **ADR-018** | Licencia MIT: auditoría de directorios y obligaciones de dependencias | RETENIDO | Archivo `LICENSE` MIT en raíz. | **Retenido / Verificado** | Establecer linter de licencias en CI para prevenir la inclusión inadvertida de dependencias con licencias copyleft virales (AGPL) o privativas. | **F8** |
| **ADR-019** | Proveedores oficiales y legacy: Meta Cloud API para garantía; legacy aislado | PENDIENTE | Conector web client legacy convive con cliente Meta preliminar. | **Parcialmente Implementado** | Priorizar conector Meta Cloud API oficial como estándar empresarial para WhatsApp e Instagram; aislar conectores web no oficiales. | **F3** |
| **ADR-020** | Campañas/consent: suppression, ventanas, política, audit | PROPUESTO | Sin capacidades de difusión masiva ni gestión de consentimiento. | **Ausente** | Crear motor de campañas con listas de supresión automáticas, verificación estricta de consentimiento y respeto a directivas de Meta/WhatsApp. | **F6** |
| **ADR-021** | Observabilidad/cost ledger: spans completos + PII minimizada + usage | PROPUESTO | Logs básicos en consola sin correlación de spans ni rastreo de costos de LLM. | **Ausente** | Implementar OpenTelemetry spans con `traceId` propagado, redacción de PII y ledger contable de tokens/costos por tenant. | **F5 / F8** |
| **ADR-022** | Upgrades/releases: migrations expand/contract, replay compatibility | PROPUESTO | Migraciones secuenciales simples 000–021 en SQL. | **Parcialmente Implementado** | Adoptar patrón expand/contract para migraciones sin downtime y validar compatibilidad retrospectiva con historial de eventos en Temporal. | **F4** |
| **ADR-023** | Móvil nativo: roadmap, tecnología por ADR separado | RETENIDO COMO ALCANCE | Desacoplado de la web actual; sin código móvil. | **Retenido como Alcance (P3)** | Definir arquitectura React Native / Expo consumiendo la API v1 y SDK oficial sin alterar el core web. | **F9** |
| **ADR-024** | Build vs fork ChatbotX: audit legal + real feature coverage; sin lock-in | PENDIENTE | Analizado conceptualmente en Blueprint v1.0. Sin código de ChatbotX en el repositorio. | **Pendiente de Auditoría** | Ejecutar auditoría legal (licencias) y técnica (acoplamiento) antes de incorporar módulos de ChatbotX, priorizando la construcción propia modular. | **F8** |

---

## 3. R3: Catálogo de Preservación de Código y Prevención de Reescrituras

Para dar cumplimiento estricto al principio de cambio mínimo y evitar la reescritura de trabajo ya probado y certificado en `integration/v0.4-consolidated`, se establece la siguiente lista taxativa de componentes que **DEBEN SER PRESERVADOS Y REUTILIZADOS**:

### 3.1 Contratos Compartidos y Tipado Central (`packages/contracts/`)
- **Archivos a preservar intactos:**
  - `src/channels/port.ts`: Define la interfaz canónica `ChannelAdapterV1` (`getCapabilities`, `validateCredentials`, `verifyWebhook`, `normalizeWebhook`, `dispatch`, `getConversationPolicy`, `checkHealth`).
  - `src/channels/schemas.ts` y `src/events.ts`: Esquemas Zod para eventos omnicanal y comandos de envío.
  - `src/conversations/commands.ts`: Comandos CAS (`TakeoverCommandV1`, `PauseAiCommandV1`, `ResumeAiCommandV1`) con soporte de versionado atómico.
  - `src/conversations/realtime.ts`: Vocabulario formal de rooms y discriminador `ServerEventV1`.
  - `src/errors/codes.ts` y `src/problemDetails.ts`: Envelope estándar RFC 7807/9457 para manejo seguro de errores sin fugas de información interna.
  - `src/adapters/`: Mappers bidireccionales legacy (`mapInboundMessage`, `mapOutboundCommand`).
- **Garantía:** 64 pruebas unitarias pasan sin requerir red externa ni dependencias de BD.

### 3.2 Capa de Autenticación y Autorización Multitenant (`WhatsaapWeb-JS/src/middleware/`)
- **`jwtAuth.ts`:**
  - Función `toPositiveInt`: Rechaza coacciones inválidas (e.g. `{ companyId: true }`).
  - Función `resolveWhatsappCompanyId`: Implementa política fail-closed sin fallback permisivo en producción.
  - Middleware `requireJwt`: Extracción estricta de claims (`companyId`, `company_id`, `tenantId`).
- **`resourceAuth.ts`:**
  - Expresiones regulares auditadas (`CHAT_ID_REGEX`, `MESSAGE_ID_REGEX`, `VOUCHER_ID_REGEX`).
  - Escapado estricto de wildcards `%` y `_` en consultas LIKE de comprobantes para evitar oráculos y SQL injection.
  - Aislamiento multitenant aplicado directamente en el `WHERE` de SQL (`AND company_id = $x`).
  - Respuestas diferenciales IDOR: `403 Forbidden` si el recurso existe pero pertenece a otra empresa; `404 Not Found` si el recurso no existe.
  - Despacho de mensajes POST hacia contactos externos (líneas 126–135) sin colisiones de identificadores entre tenants.
  - Orden estricto de middlewares en subidas de archivos: `upload.single('file')` se ejecuta antes de `requireChatTenantAccess`.

### 3.3 Suites de Regresión y Seguridad de Backend
- `WhatsaapWeb-JS/src/test/security-mitigations.test.ts`: **18 pruebas críticas** que protegen contra regresiones en JWT, SQL multitenant y parsing multipart.
- `WhatsaapWeb-JS/src/test/meta-webhook-p0.test.ts`: 8 pruebas de validación de firma HMAC-SHA256 del webhook de Meta.
- `WhatsaapWeb-JS/src/test/tools-reales-ia.test.ts`: 13 pruebas que validan el comportamiento determinista de tools de IA bajo la especificación SPEC-HU15.

### 3.4 Arnés de Orquestación Temporal OSS (`spikes/temporal/`)
- Implementación validada en TypeScript con SDK `@temporalio/*` (v1.25.0).
- Pruebas reproducibles de avance temporal (Time Skipping), reintentos con backoff exponencial, verificación de determinismo de replay y resistencia ante caída y reinicio abrupto de workers (`durability.test.ts`).
- Huella de memoria verificada en reposo: ~212 MiB RAM. Este arnés se integrará directamente como worker pool de producción en la Fase F4.

### 3.5 Especificaciones y Prototipos UX (`docs/ux/`)
- Prototipos de componentes en `docs/ux/prototypes/`:
  - `unified-shell-spec.tsx`: Navegación de 4 planos (Operations, Automation, Platform, Administration).
  - `omnichannel-inbox-spec.tsx`: Sistema de 4 paneles para atención al cliente con takeover CAS.
  - `agent-graph-spec.tsx`: Editor de grafos para agentes inteligentes con límites de presupuesto.
  - `mock-contracts.ts`: Contratos tipados de prueba.
- Estos prototipos servirán como especificación exacta y código fuente de partida para la implementación de las vistas de usuario en React.

---

## 4. R2: Roadmap Progresivo de Implementación en 10 Fases (F0 a F9)

La implementación del Blueprint v1.0 se divide en **10 fases secuenciales e independientes**, ordenadas estrictamente bajo el principio de **Seguridad, Arquitectura y Contratos antes de Funcionalidades**:

```
+----------------------------------------------------------------------------------------------------+
| F0: Consolidación y Verificación de Línea Base (M0–M5, PR-00..07, QA, UX/UI) [COMPLETADA]          |
+----------------------------------------------------------------------------------------------------+
                                                  │
                                                  ▼
+----------------------------------------------------------------------------------------------------+
| F1: Seguridad de Sockets, Tenancy y Row-Level Security en Base de Datos (WAA-002, 003, 004)        |
+----------------------------------------------------------------------------------------------------+
                                                  │
                                                  ▼
+----------------------------------------------------------------------------------------------------+
| F2: Modelo Canónico CloudEvents, Registro de Capacidades y Outbox Transaccional (WAA-005..007, 019) |
+----------------------------------------------------------------------------------------------------+
                                                  │
                                                  ▼
+----------------------------------------------------------------------------------------------------+
| F3: Operación Conversacional Omnicanal, Inbox 4 Paneles y Control CAS (WAA-008, 009, 010, 015)     |
+----------------------------------------------------------------------------------------------------+
                                                  │
                                                  ▼
+----------------------------------------------------------------------------------------------------+
| F4: Orquestación Duradera (Temporal), Versionado Inmutable y Workflows sin Canal (WAA-011, 014)     |
+----------------------------------------------------------------------------------------------------+
                                                  │
                                                  ▼
+----------------------------------------------------------------------------------------------------+
| F5: Agentes Autónomos, ModelGateway y Barrera de Seguridad ToolBroker (WAA-012, 013)               |
+----------------------------------------------------------------------------------------------------+
                                                  │
                                                  ▼
+----------------------------------------------------------------------------------------------------+
| F6: Canales Asíncronos, Campañas, Opt-in y Adaptador de Email (WAA-016, 017)                       |
+----------------------------------------------------------------------------------------------------+
                                                  │
                                                  ▼
+----------------------------------------------------------------------------------------------------+
| F7: Developer Platform, SDKs Oficiales y Sandboxing de Extensiones (WAA-018, 021)                 |
+----------------------------------------------------------------------------------------------------+
                                                  │
                                                  ▼
+----------------------------------------------------------------------------------------------------+
| F8: Hardening Empresarial, SRE, Cifrado KMS y Verificación de Cumplimiento (WAA-020, 022..025)     |
+----------------------------------------------------------------------------------------------------+
                                                  │
                                                  ▼
+----------------------------------------------------------------------------------------------------+
| F9: Expansión de Ecosistema y Clientes Móviles Nativos (WAA-026, 027, 028)                         |
+----------------------------------------------------------------------------------------------------+
```

---

### Fase F0 — Consolidación y Verificación de Línea Base (WAA-001, PROD-010, ADR-001, ADR-003) [ESTADO: COMPLETADA / DONE]

#### 1. Objetivos de la fase
- Consolidar las 6 ramas de desarrollo existentes (PR-00 a PR-07, QA y UX) en una única rama de integración limpia y determinista (`integration/v0.4-consolidated`).
- Establecer un arnés de verificación reproducible en monorepo con cero fallas de pruebas y preservación intacta de la rama `main`.
- Validar los principios de auto-hospedaje, límites de producto y modularidad sin dependencias propietarias (`PROD-010`, `ADR-001`, `ADR-003`).

#### 2. Funcionalidades abarcadas
- `WAA-001`: Consolidación y auditoría de la integración inicial en monorepo determinista.
- `SEC-001` (REST): Autenticación JWT fail-closed en endpoints HTTP y rechazo de coacciones no válidas.
- `SEC-003`: Aislamiento directo en SQL en `resourceAuth.ts` y mitigación IDOR en capa de base de datos.
- `PROD-010` (P1): Autonomía operativa completa sin dependencia de servidores propietarios del fabricante ni cuentas vendor obligatorias.
- `ADR-001`: Definición formal de límites de producto (el runtime conversacional y de automatización comparten event bus sin convertir la plataforma en un ERP/CRM monolítico).
- `ADR-003`: Arquitectura modular y monolito desacoplado en TypeScript/Node con delimitación explícita de paquetes y workers.
- Contratos tipados compartidos (`@whatsap-automat/contracts`).
- Spike empírico de durabilidad con Temporal OSS (`spikes/temporal/`).

#### 3. Módulos afectados
- `packages/contracts/`
- `WhatsaapWeb-JS/src/middleware/jwtAuth.ts`
- `WhatsaapWeb-JS/src/middleware/resourceAuth.ts`
- `WhatsaapWeb-JS/src/test/security-mitigations.test.ts`
- `spikes/temporal/`
- `docs/qa/`, `docs/ux/`

#### 4. Tareas técnicas concretas
- Auditoría y resolución de colisiones entre ramas de hitos M0 a M5.
- Fortalecimiento de coerciones booleanas en JWT (`toPositiveInt`).
- Corrección del orden de middlewares en subida de media multipart (`upload.single`).
- Implementación de 18 pruebas de mitigación de seguridad directa en SQL.
- Medición de huella de memoria y pruebas de caída abrupta en el spike de Temporal.
- Verificación de autosuficiencia y límites de producto (`PROD-010`, `ADR-001`, `ADR-003`): Garantizar ejecución determinista en local sin llamadas a infraestructuras externas no auditadas.

#### 5. Definición y alcance de PRs
- `PR-00`: Línea base monorepo y CI.
- `PR-01`: Mitigación P0 JWT y aislamiento de recursos.
- `PR-04`: Paquete de contratos canónicos `@whatsap-automat/contracts`.
- `PR-07`: Spike de viabilidad técnica Temporal OSS.
- `PR-QA`: Auditoría integral de seguridad y suite de regresión.
- `PR-UX`: Auditoría de UX, sistema de diseño y prototipos interactivos.

#### 6. Agentes responsables
- Integrador Principal, Especialista en Seguridad Backend, Auditor QA.

#### 7. Trabajos paralelizables
- Ejecución paralela de suites de pruebas en monorepo mediante GitHub Actions.

#### 8. Estrategia y cobertura de pruebas
- Ejecución de 163 pruebas: 64 en contratos, 94 en backend, 5 en temporal, build limpio en frontend.

#### 9. Criterios de aceptación objetivos
- 163/163 pruebas en estado verde (PASS).
- Rama `main` (`69ac388`) sin commits adicionales.
- Compilación de frontend sin errores de tipo ni de empaquetado.

---

### Fase F1 — Seguridad de Sockets, Tenancy y Row-Level Security en Base de Datos (WAA-002..004, SEC-001..004, ADR-002, ADR-003) [PLANNED — RECOMENDADA COMO FASE INMEDIATA]

#### 1. Objetivos de la fase
- Erradicar la vulnerabilidad crítica P0 en Socket.IO cerrando las emisiones globales y exigiendo autenticación JWT en el apretón de manos.
- Implementar Row-Level Security (RLS) en el motor PostgreSQL para garantizar defensa en profundidad frente a descuidos en consultas SQL.
- Formalizar el modelo de jerarquía de Tenancy (`Tenant` -> `Workspace` -> `company_id`) en base de datos y middleware.

#### 2. Funcionalidades abarcadas
- `WAA-002` (P0): Autenticación WebSocket JWT y rooms tenant-scoped.
- `WAA-003` (P0): PostgreSQL RLS a nivel de motor y `TenantScopedUoW`.
- `WAA-004` (P1): Migración del modelo de datos para Tenants, Workspaces y membresías.
- `SEC-001`, `SEC-002`, `SEC-003`, `SEC-004`: Gates de seguridad fail-closed y multitenancy.
- `ADR-002`: Decisión arquitectónica de Tenancy unificado.
- `ADR-003`: Modularización de sockets y transaccionalidad mediante puertos y adaptadores explícitos (desacoplamiento de workers y persistencia).

#### 3. Módulos afectados
- `WhatsaapWeb-JS/src/sockets/socketHandler.js` (Reemplazo por `socketHandler.ts`).
- `WhatsaapWeb-JS/src/sockets/socketEmitter.ts`.
- `WhatsaapWeb-JS/src/sockets/socketAuth.ts` (Nuevo middleware).
- `WhatsaapWeb-JS/src/db/migrations/023_enable_postgresql_rls.sql` (Nueva migración).
- `WhatsaapWeb-JS/src/db/migrations/024_create_tenants_and_workspaces.sql` (Nueva migración).
- `WhatsaapWeb-JS/src/db/TenantScopedUoW.ts` (Nuevo gestor transaccional).
- `WhatsaapWeb-JS/src/middleware/tenantContext.ts` (Nuevo middleware Express).
- `Frontend_py_whatsaapweb/src/utils/socket.ts`.

#### 4. Tareas técnicas concretas
1. **Reemplazo de `socketHandler.js` por `socketHandler.ts`:**
   - Incorporar `io.use(socketJwtAuthMiddleware)`: Validar token JWT en `socket.handshake.auth.token` o cabecera `Authorization`.
   - Rechazar de forma fail-closed sockets sin token o con token inválido/expirado (`err.data = { code: 'UNAUTHORIZED' }`).
   - Extraer `tenantId`, `workspaceId` y `userId` del token verificado.
   - Forzar unión automática a las rooms autorizadas por el servidor:
     * `tenant:${tenantId}`
     * `workspace:${tenantId}:${workspaceId}`
     * `user:${tenantId}:${userId}`
   - Eliminar el evento anónimo `socket.on("join", chatId)`. Reemplazarlo por `join_conversation` validando que el `chatId` pertenezca al `tenantId` verificado.
   - Eliminar la emisión global `socket.emit("chats-updated", this.whatsappService.getChats())`.
   - Desactivar o proteger con rol de administrador la acción `socket.on("logout")`.
   - Refactorizar `socketEmitter.ts` para que ningún método llame a `io.emit()` global; todas las emisiones deben requerir `tenantId` como primer argumento (`io.to('tenant:' + tenantId)...`).
2. **Implementación de PostgreSQL RLS (`023_enable_postgresql_rls.sql`):**
   - Ejecutar `ALTER TABLE <tabla> ENABLE ROW LEVEL SECURITY;` y `ALTER TABLE <tabla> FORCE ROW LEVEL SECURITY;` en todas las tablas sensibles (`conversations`, `messages`, `ai_agents`, `commercial_catalogs`, `vouchers`, etc.).
   - Crear políticas RLS:
     ```sql
     CREATE POLICY tenant_isolation_policy ON conversations
     AS RESTRICTIVE
     USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);
     ```
   - Configurar usuario de aplicación en PostgreSQL sin privilegio `BYPASSRLS`.
3. **Desarrollo de `TenantScopedUoW.ts`:**
   - Crear abstracción Unit of Work transaccional:
     * Adquiere cliente del pool de PostgreSQL.
     * Ejecuta `BEGIN`.
     * Ejecuta `SET LOCAL app.current_tenant_id = :tenantId`.
     * Ejecuta la lógica del repositorio.
     * Ejecuta `COMMIT` o `ROLLBACK`.
     * Al liberar la conexión al pool, el contexto transaccional desaparece automáticamente sin contaminar otras sesiones.
4. **Migración de Jerarquía de Tenancy (`024_create_tenants_and_workspaces.sql`):**
   - Crear tablas `tenants` (`id`, `name`, `slug`, `status`), `workspaces` (`id`, `tenant_id`, `name`, `slug`) y `memberships` (`tenant_id`, `user_id`, `role`).
   - Crear registro de tenant default vinculado a los `company_id` preexistentes para garantizar 100% de compatibilidad hacia atrás con los datos heredados.

#### 5. Definición y alcance de PRs
- **`PR-F1-01`**: `fix(security): implement fail-closed socket.io jwt handshake and tenant room isolation`.
  - Reemplazo de `socketHandler.js` por `socketHandler.ts`, eliminación de emisiones globales, suite de pruebas de sockets autenticados.
- **`PR-F1-02`**: `feat(db): implement engine-level postgresql row-level security and TenantScopedUoW`.
  - Migración RLS, pruebas adversariales de inyección SQL y cross-tenant access a nivel de base de datos.
- **`PR-F1-03`**: `feat(tenancy): add tenant and workspace domain models with legacy company_id mapping`.
  - Migración de tablas de tenancy, actualización de middleware `tenantContext` y pruebas de resolución de claims.

#### 6. Agentes responsables
- Especialista en Seguridad Backend, Arquitecto de Base de Datos PostgreSQL, QA de Integración.

#### 7. Trabajos paralelizables
- El desarrollo de la seguridad de Socket.IO (`PR-F1-01`) y el diseño de la migración RLS (`PR-F1-02`) pueden ejecutarse en paralelo en ramas independientes antes de su integración.

#### 8. Estrategia y cobertura de pruebas
- **Pruebas de Sockets (Nueva suite `socket-security.test.ts`):**
  - Conexión sin token: Rechazada con error de autenticación.
  - Conexión con token inválido/expirado: Rechazada.
  - Conexión con token válido: Aceptada, verificación de membresía en rooms del tenant.
  - Intento de suscripción a conversación de otro tenant: Rechazada con 403.
  - Emisión de evento: Solo recibida por sockets en la room del tenant correspondiente.
- **Pruebas de RLS (Nueva suite `rls-isolation.test.ts`):**
  - Consulta con `app.current_tenant_id` establecido: Solo devuelve registros del tenant.
  - Consulta sin `app.current_tenant_id`: Devuelve 0 registros (fail-closed).
  - Intento de `SELECT * FROM conversations WHERE company_id = 2` ejecutado desde contexto del tenant 1: Devuelve 0 filas a nivel de motor.
- **Pruebas de Regresión:**
  - Ejecución de las 18 pruebas en `security-mitigations.test.ts` para verificar cero regresiones.

#### 9. Criterios de aceptación objetivos
- Sockets anónimos no pueden establecer conexión bajo ninguna circunstancia.
- Zero emisiones globales detectadas (`grep -rn "ioInstance.emit" WhatsaapWeb-JS/src/` devuelve 0 ocurrencias no tipadas).
- Base de datos rechaza o filtra a nivel de RLS cualquier consulta que intente saltarse el tenant, con o sin cláusula `WHERE`.
- Las 163 pruebas existentes + nuevas pruebas de sockets y RLS en estado 100% PASS.

---

### Fase F2 — Modelo Canónico, Registro de Capacidades y Outbox Transaccional (WAA-005..007, WAA-019, SEC-005, PROD-004, PROD-012, ADR-004, ADR-005, ADR-007, ADR-016) [PLANNED]

#### 1. Objetivos de la fase
- Establecer el modelo canónico de eventos basado en la especificación CloudEvents 1.0 (`CanonicalEventV1`).
- Construir el Registro de Capacidades de Canales (`CapabilityRegistry`) con evaluación dinâmica en 6 dimensiones.
- Implementar el patrón Outbox Transaccional (`ProcessingOutbox`) para garantizar ingreso y despacho confiable con estado `delivery_unknown`.
- Incorporar los tokens y foundations del sistema de diseño "Automat UI" en el frontend.

#### 2. Funcionalidades abarcadas
- `WAA-005` (P1): Esquema de eventos canónicos compatible con CloudEvents 1.0.
- `WAA-006` (P1): Registro dinámico de capacidades de canales y validación pre-publish.
- `WAA-007` (P1): Tabla `processing_outbox`, deduplicación transaccional y registro de idempotencia.
- `WAA-019` (P1): Tokens de diseño "Automat UI" y compatibilidad WCAG 2.2 AA.
- `SEC-005`: Verificación criptográfica de firma HMAC, ventana de timestamp anti-replay y deduplicación transaccional de webhooks en ingreso.
- `PROD-004` (P1): Acciones y activadores condicionados estrictamente por capacidades reales de conexión con bloqueo determinista en el publish gate.
- `PROD-012` (P1): Inventario verificable de capacidades por canal/conexión evaluado mediante suite de contratos independiente.
- `ADR-004`, `ADR-005`, `ADR-007`, `ADR-016`: Decisiones normativas de arquitectura.

#### 3. Módulos afectados
- `packages/contracts/src/events/canonical.ts` (Nuevo contrato).
- `packages/contracts/src/channels/capabilities.ts`.
- `WhatsaapWeb-JS/src/db/migrations/025_create_processing_outbox_and_capabilities.sql`.
- `WhatsaapWeb-JS/src/services/outbox/OutboxRepository.ts`.
- `WhatsaapWeb-JS/src/services/channels/CapabilityRegistry.ts`.
- `Frontend_py_whatsaapweb/src/styles/tokens.css` (Nuevos tokens).
- `Frontend_py_whatsaapweb/tailwind.config.js`.

#### 4. Tareas técnicas concretas
1. **Contratos CloudEvents (`packages/contracts`):**
   - Definir esquema Zod `CanonicalEventV1`: `id`, `source`, `specversion: "1.0"`, `type`, `time`, `datacontenttype: "application/json"`, `tenant_id`, `workspace_id`, `connection_id`, `correlation_id`, `causation_id`, `data`.
   - Implementar adaptadores bidireccionales entre eventos externos y `CanonicalEventV1`.
2. **Registro de Capacidades (`CapabilityRegistry`, `PROD-004`, `PROD-012`, `ADR-005`):**
   - Modelar dimensiones: soporte técnico, scopes concedidos, políticas de servicio (e.g. ventana de 24h WhatsApp), salud de conexión, presupuesto/costo y restricciones regionales.
   - Crear suite de contratos independiente para verificar el inventario de capacidades por conexión (`PROD-012`).
   - Desarrollar servicio que evalúe y bloquee acciones no permitidas en tiempo de ejecución devolviendo RFC 7807 `ProblemDetails` (`CH_WA_WINDOW_CLOSED`, `CAPABILITY_UNSUPPORTED`) y publish gate con bloqueo previo (`PROD-004`).
3. **Persistencia Transaccional Outbox y Seguridad de Ingestión (`SEC-005`, `WAA-007`, `ADR-007`):**
   - Crear tabla `processing_outbox` (`id`, `tenant_id`, `event_type`, `payload`, `status: pending|processing|dispatched|failed|dead_letter`, `retry_count`, `next_retry_at`, `created_at`).
   - Crear tabla `idempotency_keys` para deduplicación estricta de webhooks entrantes y despachos salientes (`SEC-005`).
   - Modificar endpoint de webhook de WhatsApp para que en **una sola transacción**: (a) valide firma HMAC y timestamp anti-replay (`SEC-005`), (b) guarde evento canónico, (c) inserte registro en `processing_outbox` y (d) responda HTTP 200 inmediatamente.
4. **Fundación "Automat UI" en Frontend:**
   - Importar tokens de diseño de `docs/ux/04_SISTEMA_DISENO_Y_TOKENS.md` a variables CSS (colores semánticos, espaciado, tipografía, radios).
   - Configurar soporte nativo de temas Claro, Oscuro y Alto Contraste.

#### 5. Definición y alcance de PRs
- **`PR-F2-01`**: `feat(contracts): add canonical CloudEvents v1 and capability matrix schemas (PROD-012, ADR-004, ADR-005)`.
- **`PR-F2-02`**: `feat(backend): implement transactional processing outbox, idempotency ledger and capability registry (SEC-005, PROD-004, ADR-007)`.
- **`PR-F2-03`**: `feat(ui): integrate Automat UI design tokens and theme foundation (WAA-019, ADR-016)`.

#### 6. Agentes responsables
- Ingeniero de Contratos y Protocolos, Especialista Backend de Base de Datos, Diseñador Frontend UI.

#### 7. Trabajos paralelizables
- La integración de tokens en el frontend (`PR-F2-03`) es 100% desacoplada del trabajo de base de datos y outbox en backend (`PR-F2-02`).

#### 8. Estrategia y cobertura de pruebas
- Pruebas unitarias en contratos para validación y parsing de `CanonicalEventV1`.
- Pruebas de transacción atómica: Si la inserción en el outbox falla, el evento no se persiste y se retorna error sin confirmar al proveedor externo.
- Pruebas de deduplicación: Envío repetido del mismo `provider_message_id` solo genera un registro en el outbox.
- Verificación de contraste WCAG 2.2 AA en tokens CSS.

#### 9. Criterios de aceptación objetivos
- Webhooks de ingreso responden HTTP 200 en menos de 50 ms persistiendo en el outbox.
- Duplicados de webhooks detectados y descartados con cero efectos secundarios.
- Registro de capacidades bloquea mensajes libres cuando la ventana de 24h de WhatsApp está vencida.
- 100% de suites en monorepo pasando.

---

### Fase F3 — Operación Conversacional, Inbox de 4 Paneles y Control de Concurrencia CAS (WAA-008..010, WAA-015, SEC-004, PROD-002, PROD-003, PROD-005, PROD-013, ADR-008, ADR-019) [PLANNED]

#### 1. Objetivos de la fase
- Implementar el control de concurrencia optimista Compare-And-Swap (CAS) con `ownership_epoch` para evitar respuestas simultáneas de humanos e IA.
- Incorporar adaptadores de canal para Meta Cloud API (WhatsApp e Instagram Social Triggers), Telegram Bot API y Webchat.
- Construir el Inbox Omnicanal Unificado como Sistema de Trabajo de 4 paneles en React.

#### 2. Funcionalidades abarcadas
- `WAA-008` (P1): Transferencia de propiedad Humano <-> IA mediante CAS y versión.
- `WAA-009` (P1): Meta Cloud API y Triggers Sociales de Instagram (Comments, Mentions, Comment-to-DM).
- `WAA-010` (P1): Telegram Bot API y Webchat auto-hospedado.
- `WAA-015` (P1): Inbox de 4 paneles con colas de trabajo, SLAs y compositor regulado por capacidades.
- `PROD-002`, `PROD-003`, `PROD-005`: Requerimientos de producto omnicanal y handoff determinista.
- `PROD-013` (P2): Routing por colas de trabajo, disponibilidad operativa de agentes, skills y prioridades configurables.
- `SEC-004` (Concurrencia): Fencing token y verificación de roles server-side en cambios de propiedad conversacional.
- `ADR-008`: Protocolo de propiedad conversacional CAS (`ownership_epoch` y versionado optimista) para evitar race conditions humano/IA.
- `ADR-019`: Estrategia de adopción de proveedores oficiales (Meta Cloud API / Instagram Graph API) manteniendo aislamiento de canales legacy.

#### 3. Módulos afectados
- `WhatsaapWeb-JS/src/db/migrations/026_add_conversation_cas_and_channels.sql`.
- `WhatsaapWeb-JS/src/services/channels/MetaCloudAdapter.ts`.
- `WhatsaapWeb-JS/src/services/channels/TelegramAdapter.ts`.
- `WhatsaapWeb-JS/src/services/channels/WebchatAdapter.ts`.
- `WhatsaapWeb-JS/src/services/conversations/ConversationCasService.ts`.
- `Frontend_py_whatsaapweb/src/pages/Inbox/` (Nueva estructura basada en prototipo).
- `Frontend_py_whatsaapweb/src/components/inbox/` (Paneles de Navegación, Cola, Chat y Contexto).

#### 4. Tareas técnicas concretas
1. **Concurrencia CAS en Conversaciones (`026_add_conversation_cas...`):**
   - Añadir columnas `version integer NOT NULL DEFAULT 1` y `ownership_epoch integer NOT NULL DEFAULT 0` a la tabla `conversations`.
   - Implementar método atómico `takeoverConversation(conversationId, agentId, expectedVersion)`:
     ```sql
     UPDATE conversations
     SET owner_type = 'human', owner_id = :agentId, ownership_epoch = ownership_epoch + 1, version = version + 1
     WHERE id = :conversationId AND version = :expectedVersion;
     ```
   - Si `affected_rows == 0`, responder HTTP 409 Conflict.
   - Enviar evento en tiempo real `conversation.ownership_changed` a la room del tenant.
   - En despachadores automáticos de IA: revalidar versión y epoch antes de emitir mensaje; abortar si la conversación fue tomada por un humano.
2. **Adaptadores de Canal Oficiales:**
   - Desarrollar `MetaCloudAdapter`: Normalización de mensajes de WhatsApp, DMs de Instagram, y eventos de comentarios de publicaciones con respuesta pública o comment-to-DM.
   - Desarrollar `TelegramAdapter`: Procesamiento de updates de Telegram Bot API mediante webhook o polling local.
   - Desarrollar `WebchatAdapter`: Canal de chat embebido para sitios web mediante WebSockets con token de sesión de visitante.
3. **Inbox Omnicanal de 4 Paneles en React:**
   - Trasladar el código del prototipo `docs/ux/prototypes/omnichannel-inbox-spec.tsx` al frontend productivo:
     * *Panel 1 (Navegación):* Filtros por canales, estados y bandejas de entrada.
     * *Panel 2 (Cola de Trabajo, PROD-013):* Listado ordenado por prioridad, SLA restante, última actividad, routing por colas y asignación según skills y disponibilidad de agentes.
     * *Panel 3 (Conversación y Timeline):* Línea de tiempo unificada con mensajes, notas internas y eventos de sistema; compositor condicionado por la ventana de 24h.
     * *Panel 4 (Contexto del Contacto):* Perfil consolidado, variables personalizadas, tags y control de handoff IA/Humano con botón "Tomar Conversación" (CAS).

#### 5. Definición y alcance de PRs
- **`PR-F3-01`**: `feat(conversations): implement atomic CAS concurrency and human-ai ownership epoch (WAA-008, SEC-004, ADR-008, PROD-005)`.
- **`PR-F3-02`**: `feat(channels): implement Meta Cloud API, Instagram social triggers and Telegram adapters (WAA-009, WAA-010, ADR-019)`.
- **`PR-F3-03`**: `feat(inbox): build 4-pane responsive workspace inbox with SLA routing, skills and takeover UI (WAA-015, PROD-002, PROD-003, PROD-013)`.

#### 6. Agentes responsables
- Especialista en Integraciones de Mensajería, Desarrollador Backend de Dominio, Ingeniero Frontend React.

#### 7. Trabajos paralelizables
- Los adaptadores de canales externos (`PR-F3-02`) y la interfaz de usuario del Inbox (`PR-F3-03`) pueden construirse en paralelo consumiendo los contratos canónicos de la Fase F2.

#### 8. Estrategia y cobertura de pruebas
- Pruebas de estrés y carrera (race conditions): 50 peticiones simultáneas de takeover solo permiten exactamente una actualización CAS exitosa; 49 reciben 409 Conflict.
- Pruebas de simulación de mensajes de IA: Un worker de IA en proceso de generación aborta el envío al detectar incremento de `ownership_epoch`.
- Pruebas de parseo de webhooks de Instagram y Telegram contra fixtures reales anonimizadas.
- Pruebas de componentes React del Inbox con React Testing Library.

#### 9. Criterios de aceptación objetivos
- Cero respuestas dobles (humano e IA respondiendo al mismo cliente en simultáneo).
- Mensajes y comentarios entrantes de WhatsApp, Instagram y Telegram visibles en tiempo real en la bandeja de entrada.
- Compositor deshabilita la entrada de texto libre y exige plantilla cuando la ventana de 24h de WhatsApp está expirada.
- Inbox de 4 paneles renderiza en desktop y colapsa limpiamente en dispositivos móviles.

---

### Fase F4 — Orquestación Duradera, Versionado Inmutable y Workflows sin Canal (WAA-011, WAA-014, PROD-001, PROD-006, ADR-001, ADR-006, ADR-010, ADR-022) [PLANNED]

#### 1. Objetivos de la fase
- Conectar el motor de orquestación duradera Temporal OSS al backend productivo mediante un relay que procese `processing_outbox`.
- Implementar el versionado inmutable de definiciones de workflows con activación atómica y rollback sin interrupción de ejecuciones en curso.
- Construir el diseñador visual "Automation Studio" (Canvas DAG y Outline estructurado) para flujos conversacionales y automatizaciones de negocio sin canal (UC-06).

#### 2. Funcionalidades abarcadas
- `WAA-011` (P1): Bridge entre Outbox y Temporal OSS, motor de revisiones inmutables.
- `WAA-014` (P1): Automation Studio (Canvas + Outline) y ejecución de procesos de negocio sin canal (webhooks ERP/CRM, schedules).
- `PROD-001`, `PROD-006`: Automatización unificada y rollback seguro.
- `ADR-001`: Preservación rigurosa de límites de producto (workflows de negocio sin canal UC-06 sobre el bus de eventos sin replicar un ERP/CRM integral).
- `ADR-006`, `ADR-010`, `ADR-022`: Decisiones normativas de arquitectura y despliegues sin tiempo de inactividad.

#### 3. Módulos afectados
- `WhatsaapWeb-JS/src/temporal/` (Incorporación del arnés de `spikes/temporal/`).
- `WhatsaapWeb-JS/src/services/outbox/OutboxRelayDaemon.ts`.
- `WhatsaapWeb-JS/src/db/migrations/027_create_workflows_and_revisions.sql`.
- `WhatsaapWeb-JS/src/services/workflows/WorkflowEngine.ts`.
- `Frontend_py_whatsaapweb/src/pages/Automation/AutomationStudio.tsx`.
- `Frontend_py_whatsaapweb/src/components/canvas/WorkflowCanvas.tsx`.

#### 4. Tareas técnicas concretas
1. **Bridge Outbox -> Temporal OSS:**
   - Integrar los paquetes `@temporalio/client` y `@temporalio/worker` en `WhatsaapWeb-JS`.
   - Desarrollar `OutboxRelayDaemon`: Poller transaccional que lee registros `pending` en `processing_outbox`, los despacha como eventos o workflows a Temporal, y marca el outbox como `dispatched`.
   - Configurar Temporal Activities para el despacho seguro de mensajes con clave de idempotencia determinista (`msg_{runId}_{stepId}`).
2. **Persistencia y Versionado Inmutable (`027_create_workflows...`):**
   - Tablas: `workflow_definitions` (contenedor lógico), `workflow_revisions` (grafo inmutable JSONB, estado `draft|published|archived`), `workflow_runs` (ejecución atada a una revisión inmutable específica).
   - Rollback atómico: Cambiar el puntero `published_revision_id` en la definición. Las ejecuciones en curso continúan en su revisión original sin riesgo de corrupción de estado.
3. **Automatización de Negocio sin Canal (UC-06):**
   - Permitir triggers no conversacionales: webhooks entrantes (JSON payload de ERP/facturación), cron schedules (temporizadores duraderos), y eventos de sistema.
   - Ejecución de grafos DAG con nodos estándar: Triggers, Conditions/Branching, HTTP Request externo, Delay persistente, Form/Approval humano.
4. **Automation Studio en Frontend:**
   - Vista dual sincronizada: Lienzo gráfico visual (Canvas con nodos y aristas) y Vista jerárquica de árbol/esquema (Outline).
   - Panel de inspección de ejecuciones en tiempo real (Run Inspector) con resaltado del nodo activo y estado de variables.

#### 5. Definición y alcance de PRs
- **`PR-F4-01`**: `feat(temporal): integrate production durable orchestration bridge and outbox relay daemon`.
- **`PR-F4-02`**: `feat(workflows): implement immutable revisioning, DAG engine and channel-less business triggers`.
- **`PR-F4-03`**: `feat(studio): build Automation Studio with synchronized Canvas and Outline views`.

#### 6. Agentes responsables
- Arquitecto de Sistemas Distribuidos, Desarrollador de Motor de Automatización, Especialista de UI Canvas.

#### 7. Trabajos paralelizables
- La construcción del frontend de Automation Studio (`PR-F4-03`) puede realizarse en paralelo con el desarrollo del bridge de Temporal en el backend (`PR-F4-01`).

#### 8. Estrategia y cobertura de pruebas
- Pruebas de resiliencia ante caídas de workers: Se inicia un workflow con temporizador de 2 horas, se mata el proceso worker (`kill -9`), se reinicia y se valida que el workflow continúa sin reiniciarse desde el nodo 1.
- Pruebas de determinismo de replay de Temporal.
- Pruebas de rollback de revisión: Lanzar instancia en Rev 1, publicar Rev 2, revertir a Rev 1; validar que nuevas ejecuciones usan Rev 1 y la instancia activa termina en Rev 1.
- Pruebas de triggers HTTP de ERP simulados sin ningún canal de mensajería configurado.

#### 9. Criterios de aceptación objetivos
- Cero pérdida de eventos ante caídas o reinicios forzados del backend.
- Flujos con retrasos largos (días/semanas) completados fielmente sin consumir memoria activa en reposo.
- Creación y ejecución exitosa de un flujo de negocio sin canal (e.g. Ingestión de webhook de orden de venta -> Verificación -> Notificación por webhook).
- Rollback de versión de workflow ejecutable en menos de 1 segundo.

---

### Fase F5 — Agentes Autónomos, ModelGateway y Barrera de Seguridad ToolBroker (WAA-012, WAA-013, SEC-007, PROD-009, PROD-017, ADR-009, ADR-010, ADR-011, ADR-012) [PLANNED]

#### 1. Objetivos de la fase
- Establecer el `ModelGateway` neutral para LLMs con soporte de Bring-Your-Own-Key (BYOK) para OpenAI, Anthropic y modelos locales.
- Implementar la barrera arquitectónica externa `ToolBroker` para ejecución segura de herramientas fuera del prompt del LLM (SSRF firewall, RBAC, límites de presupuesto y aprobación HITL).
- Construir "Agent Studio" con vistas Guiada y Avanzada, memoria contextual aislada por tenant y arnés de evaluación de regresión.

#### 2. Funcionalidades abarcadas
- `WAA-012` (P1): Runtime de agentes, ModelGateway BYOK y ToolBroker server-side.
- `WAA-013` (P1): Agent Studio (Guided & Advanced), RAG aislado con pgvector y simulador de evals.
- `SEC-007`: Control estricto de egress y mitigación SSRF en herramientas.
- `PROD-009`, `PROD-017`: Pasarela neutral de modelos y gobernanza de IA.
- `ADR-009`, `ADR-010`, `ADR-011`, `ADR-012`: Decisiones de diseño de agentes, semántica diferenciada frente a automatizaciones y seguridad de tools.

#### 3. Módulos afectados
- `WhatsaapWeb-JS/src/services/ai/ModelGateway.ts`.
- `WhatsaapWeb-JS/src/services/ai/ToolBroker.ts` (Nueva barrera de seguridad).
- `WhatsaapWeb-JS/src/services/ai/tools/` (Registro de tools con clasificación de riesgo).
- `WhatsaapWeb-JS/src/services/ai/KnowledgeBaseService.ts` (RAG con pgvector).
- `WhatsaapWeb-JS/src/db/migrations/028_create_agents_and_tools.sql`.
- `Frontend_py_whatsaapweb/src/pages/AgentStudio/` (Basado en prototipo `agent-graph-spec.tsx`).

#### 4. Tareas técnicas concretas
1. **ModelGateway Neutral con BYOK:**
   - Adaptador unificado para proveedores de LLM: OpenAI (`gpt-4o`, `o3`), Anthropic (`claude-3-5-sonnet`), y endpoints locales compatibles con OpenAI (Ollama, vLLM).
   - Cifrado de claves API por tenant en base de datos; contabilidad estricta de tokens y costos por ejecución.
2. **Barrera de Seguridad `ToolBroker` (Línea de Defensa Externa):**
   - El LLM **nunca** ejecuta herramientas directamente ni accede a la red. El LLM propone una llamada de herramienta; el `ToolBroker` la intercepta y valida:
     * *Autenticación y Tenancy:* Confirma que el agente tenga permiso para invocar la tool en el workspace.
     * *Filtro SSRF y Red Egress:* Bloquea destinos a IPs privadas (RFC 1918: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), enlaces locales (`169.254.0.0/16`) y localhost (`127.0.0.1`).
     * *Clasificación de Riesgo y Aprobación HITL:* Categorías `read`, `write`, `send`, `financial`, `destructive`. Operaciones financieras o destructivas se pausan automáticamente generando una solicitud de aprobación humana.
     * *Validación CAS:* Antes de enviar mensajes a clientes, el ToolBroker valida la versión de la conversación para confirmar que un humano no tomó el control.
3. **Memoria y RAG Aislado por Tenant:**
   - Indexación vectorial de documentos en PostgreSQL utilizando extensión `pgvector`.
   - Búsqueda restringida a nivel de SQL con filtro de tenant obligatorio (`WHERE tenant_id = :id`).
   - Soporte de políticas de olvido (Right to be Forgotten) para borrar la memoria de clientes que lo soliciten.
4. **Agent Studio y Evaluador de Regresión:**
   - Interfaz en React con pestañas: Instrucciones, Conocimiento, Herramientas, Grafo de Razonamiento, Políticas de Seguridad y Evaluaciones.
   - Simulador de evals: Ejecuta conjuntos de prueba deterministas antes de permitir la publicación de un agente, bloqueando versiones que fallen pruebas de seguridad o precisión.

#### 5. Definición y alcance de PRs
- **`PR-F5-01`**: `feat(ai): implement neutral ModelGateway with BYOK and token cost ledger`.
- **`PR-F5-02`**: `feat(security): implement ToolBroker server-side authorization barrier and SSRF egress firewall`.
- **`PR-F5-03`**: `feat(agents): build Agent Studio UI, pgvector tenant RAG and regression evaluation simulator`.

#### 6. Agentes responsables
- Especialista en Seguridad de IA y LLMs, Ingeniero Backend de Integraciones, Desarrollador Frontend de Estudios.

#### 7. Trabajos paralelizables
- El desarrollo del `ModelGateway` (`PR-F5-01`) y el frontend de `Agent Studio` (`PR-F5-03`) pueden avanzar de manera paralela una vez acordados los esquemas de contrato de agentes.

#### 8. Estrategia y cobertura de pruebas
- Pruebas de inyección de prompts adversariales: Intentos de engañar al LLM para invocar herramientas no autorizadas o consultar URLs privadas (`http://169.254.169.254/latest/meta-data/`) son interceptados y bloqueados al 100% por el `ToolBroker`.
- Pruebas de aislamiento RAG: Búsqueda vectorial nunca retorna chunks de documentos pertenecientes a otro tenant.
- Pruebas de presupuesto: Agentes que exceden límite de pasos (e.g. 15 pasos) o tokens se cancelan de inmediato.
- Pruebas de aprobación HITL: Herramienta financiera pasa a estado `waiting_approval` y no ejecuta la acción hasta que un usuario supervisor emite la aprobación.

#### 9. Criterios de aceptación objetivos
- Cero escapes de red hacia direcciones IP privadas o de metadatos de nube.
- Ninguna herramienta con categoría de riesgo alta se ejecuta sin validación de permisos o aprobación humana previa.
- Aislamiento cross-tenant verificado al 100% en almacenamiento vectorial y ejecución de agentes.
- Evaluador de regresión previene la publicación de agentes con score inferior al umbral definido.

---

### Fase F6 — Canales Asíncronos, Campañas y Verificación de Consentimiento (WAA-016, WAA-017, SEC-008, PROD-007, ADR-020) [PLANNED]

#### 1. Objetivos de la fase
- Implementar el motor de campañas de difusión saliente con segmentación dinámica de audiencias y control de cuotas.
- Establecer el sistema estricto de consentimiento auditable (`ConsentRecord`) con listas de supresión automáticas y respeto a la ventana de 24h de WhatsApp.
- Incorporar el adaptador de canal de Correo Electrónico (SMTP saliente / IMAP entrante con threading conversacional).

#### 2. Funcionalidades abarcadas
- `WAA-016` (P1): Segmentación, gestión de consentimiento y despachador de campañas throttled.
- `WAA-017` (P1): Adaptador de canal Email SMTP/IMAP.
- `SEC-008`: Verificación obligatoria de opt-in y listas de supresión.
- `PROD-007`: Requerimiento de campañas basadas en cumplimiento.
- `ADR-020`: Decisión normativa de consentimiento y límites de difusión.

#### 3. Módulos afectados
- `WhatsaapWeb-JS/src/db/migrations/029_create_campaigns_and_consent.sql`.
- `WhatsaapWeb-JS/src/services/campaigns/CampaignDispatcher.ts`.
- `WhatsaapWeb-JS/src/services/campaigns/SegmentationService.ts`.
- `WhatsaapWeb-JS/src/services/channels/EmailAdapter.ts`.
- `Frontend_py_whatsaapweb/src/pages/Campaigns/CampaignWizard.tsx`.
- `Frontend_py_whatsaapweb/src/pages/Contacts/SegmentsManager.tsx`.

#### 4. Tareas técnicas concretas
1. **Persistencia de Consentimiento y Campañas (`029_create_campaigns...`):**
   - Tabla `consent_records`: `id`, `tenant_id`, `contact_id`, `channel_type`, `destination`, `purpose`, `status: opted_in|opted_out`, `evidence_type`, `evidence_proof`, `opted_in_at`, `revoked_at`.
   - Tabla `segments`: Criterios dinámicos en JSONB (tags, atributos, fecha de última interacción).
   - Tabla `campaigns`: Relación con plantilla aprobada de Meta, segmento objetivo, límites de tasa por minuto y métricas de entrega.
2. **Despachador Throttled con Supresión Automática:**
   - Despacho regulado por colas para no superar límites de los proveedores ni disparar bloqueos por spam.
   - Verificación de consentimiento antes de cada envío individual: Si el contacto tiene estado `opted_out` o revocó permiso, se descarta el mensaje inmediatamente.
   - En canales Meta (WhatsApp/Instagram): Exigir uso de plantilla aprobada con variables validadas.
3. **Adaptador de Canal de Correo Electrónico (`EmailAdapter`):**
   - Conexión saliente SMTP con TLS obligatorio y soporte de firma DKIM.
   - Polling de buzón entrante IMAP: Normalización de correos a eventos de conversación, asociando respuestas a hilos existentes mediante cabeceras `In-Reply-To` y `Message-ID`.

#### 5. Definición y alcance de PRs
- **`PR-F6-01`**: `feat(compliance): implement consent records ledger, suppression engine and segmentation`.
- **`PR-F6-02`**: `feat(campaigns): build throttled campaign broadcast dispatcher with provider rate limiting`.
- **`PR-F6-03`**: `feat(channels): implement email SMTP and IMAP channel adapter with thread tracking`.

#### 6. Agentes responsables
- Desarrollador Backend de Cumplimiento, Especialista en Canales de Mensajería, Desarrollador Frontend Operativo.

#### 7. Trabajos paralelizables
- El desarrollo del adaptador de Email (`PR-F6-03`) puede ejecutarse de forma 100% paralela con el motor de campañas y consentimiento (`PR-F6-01` y `PR-F6-02`).

#### 8. Estrategia y cobertura de pruebas
- Pruebas de supresión de envíos: Contactos marcados como `opted_out` nunca reciben mensajes de campaña, registrando la razón en el log de auditoría.
- Pruebas de rate-limiting: Campaña masiva de 5,000 mensajes respeta estrictamente la tasa configurada (e.g. máximo 50 mensajes/minuto).
- Pruebas de parseo de correos electrónicos con adjuntos multipart e hilos de conversación.

#### 9. Criterios de aceptación objetivos
- Cero envíos realizados a contactos sin registro formal de opt-in o en lista de supresión.
- Pausa automática de campañas si la tasa de fallas del proveedor supera el 5%.
- Correos entrantes recibidos por IMAP se reflejan en el Inbox Omnicanal unificado de la Fase F3.

---

### Fase F7 — Developer Platform, SDKs Oficiales y Sandboxing de Extensiones (WAA-018, WAA-021, SEC-009, PROD-008, PROD-016, ADR-014, ADR-015) [PLANNED]

#### 1. Objetivos de la fase
- Publicar la suite oficial de SDKs TypeScript (`@whatsap-automat/*`) y la especificación pública OpenAPI v1.
- Desarrollar la herramienta de línea de comandos CLI (`automat`) para scaffolding, pruebas y empaquetado de extensiones.
- Implementar la arquitectura de aislamiento y sandboxing para plugins de backend (subprocesos/WASI) y extensiones de UI (iframes sandboxed con RPC tipado).

#### 2. Funcionalidades abarcadas
- `WAA-018` (P1): OpenAPI v1 contract-first, SDK TypeScript oficial y webhooks salientes con firma HMAC.
- `WAA-021` (P2): Sandboxing de extensiones de backend e iframes para extensiones de frontend.
- `SEC-009`: Aislamiento estricto de código no confiable.
- `PROD-008`, `PROD-016`: Plataforma de desarrolladores y ecosistema de terceros.
- `ADR-014`, `ADR-015`: Decisiones normativas de extensibilidad.

#### 3. Módulos afectados
- `packages/sdk/` (Nuevo paquete).
- `packages/channel-sdk/`, `packages/connector-sdk/`, `packages/agent-tool-sdk/`, `packages/ui-extension-sdk/` (Nuevos paquetes).
- `packages/cli/` (Nuevo paquete CLI `automat`).
- Host de ejecución de extensiones con aislamiento del sistema operativo, pendiente de implementación.
- `WhatsaapWeb-JS/src/services/webhooks/OutboundWebhookSigner.ts`.
- `Frontend_py_whatsaapweb/src/components/extensions/SandboxedExtensionIframe.tsx`.

#### 4. Tareas técnicas concretas
1. **Publicación de SDKs y OpenAPI v1:**
   - Exponer especificación OpenAPI v1 generada a partir de los contratos Zod de `packages/contracts`.
   - Paquete `@whatsap-automat/sdk`: Cliente HTTP tipado con soporte de paginación por cursor y reintentos automáticos.
   - `OutboundWebhookSigner`: Despacho de webhooks de negocio hacia sistemas externos con firma HMAC-SHA256 en cabecera `X-Automat-Signature` y ventana anti-replay de 5 minutos.
2. **CLI Developer Tooling (`automat`):**
   - Comandos: `automat init <plugin>`, `automat dev`, `automat validate <manifest>`, `automat pack`.
3. **Sandboxing de Extensiones de Backend:**
   - Host de extensiones fuera del proceso principal de Node.js (subproceso restringido con límites de CPU y memoria).
   - Comunicación exclusiva mediante JSON-RPC sobre stdin/stdout; sin acceso directo a la base de datos de producción ni variables de entorno del servidor central.
4. **Sandboxing de Extensiones de UI:**
   - Renderizado de componentes de terceros dentro de un `<iframe>` con directivas CSP estrictas (`sandbox="allow-scripts"`).
   - Protocolo tipado postMessage RPC para solicitar datos o acciones al host con validación de origen.

#### 5. Definición y alcance de PRs
- **`PR-F7-01`**: `feat(developer): expose public OpenAPI v1, publish @whatsap-automat/sdk and signed webhooks`.
- **`PR-F7-02`**: `feat(cli): create automat developer CLI for extension scaffolding and testing`.
- **`PR-F7-03`**: `feat(sandbox): implement out-of-process backend extension host and secure iframe UI slots`.

#### 6. Agentes responsables
- Ingeniero de Developer Experience (DevEx), Especialista en Seguridad y Sandboxing, Desarrollador de SDKs.

#### 7. Trabajos paralelizables
- La creación de la CLI (`PR-F7-02`) y la publicación del SDK cliente (`PR-F7-01`) pueden realizarse en paralelo con el host de sandboxing (`PR-F7-03`).

#### 8. Estrategia y cobertura de pruebas
- Las pruebas adversariales deben verificar que un plugin carece de acceso a los archivos y secretos del servidor, que solo puede acceder a la red según sus permisos y que sus límites de CPU y memoria protegen al proceso principal.
- Pruebas de extensiones de UI: Código JavaScript en el iframe no puede acceder a `window.parent`, cookies o local storage del host central.
- Pruebas de verificación de firma HMAC en webhooks salientes.

#### 9. Criterios de aceptación objetivos
- Extensiones de terceros pueden registrarse y ejecutarse sin posibilidad física de comprometer la memoria, la BD o la estabilidad del núcleo.
- Paquete `@whatsap-automat/sdk` compila y se prueba con TypeScript en modo estricto.
- Webhooks salientes verificables mediante cabecera criptográfica estándar.

---

### Fase F8 — Hardening Empresarial, SRE y Verificación de Cumplimiento (WAA-020, WAA-022..025, SEC-006, SEC-010..012, PROD-011, PROD-014, PROD-015, ADR-013, ADR-017, ADR-018, ADR-021, ADR-024) [PLANNED]

#### 1. Objetivos de la fase
- Implementar el asistente de salud diagnóstica (`doctor`) y procedimientos de autorreparación guiada de canales.
- Automatizar respaldos consistentes y ensayos periódicos de restauración sin pérdida de datos.
- Fortalecer la seguridad empresarial: Cifrado envelope de credenciales (KMS/AES-256-GCM), RBAC granular, SSO/OIDC y pistas de auditoría append-only.
- Certificar el cumplimiento de licencia (100% MIT) y generación automatizada de SBOM (Software Bill of Materials).
- Ejecutar la auditoría técnica y legal formal de las hipótesis de fork de terceros (ChatbotX / Flowise / Activepieces).

#### 2. Funcionalidades abarcadas
- `WAA-020` (P2): Channel wizard y diagnostic doctor (`CH-<CHAN>-<NUM>`).
- `WAA-022` (P2): Automatización de respaldo y ensayo de restauración en entorno limpio.
- `WAA-023` (P2): RBAC empresarial, autenticación OIDC/SSO, auditoría append-only y cifrado de secrets.
- `WAA-024` (P2): Auditoría de licencias de dependencias, SBOM CycloneDX y compilación CE verificada.
- `WAA-025` (P2): Auditoría técnica y legal de hipótesis de terceros.
- `SEC-006`, `SEC-010`, `SEC-011`, `SEC-012`: Gates de producción de seguridad y disaster recovery.
- `PROD-011` (P1): Instalación Community Edition (CE) verificada con funcionalidades esenciales operativas mediante smoke test independiente sin licencias externas.
- `PROD-014` (P2): Diagnóstico y replay autorizados mediante herramienta de salud (`automat doctor` CLI/UI) con evidencia redactada.
- `PROD-015` (P2): Procedimientos guiados y automatizados de backup, upgrade y ensayo de restauración (`restore rehearsal`).
- `ADR-013`, `ADR-018`, `ADR-021`, `ADR-024`: Decisiones normativas de gobernanza.
- `ADR-017`: Soberanía total del despliegue auto-hospedado (`self-hosted`) con edición comunitaria independiente y cloud opcional.

#### 3. Módulos afectados
- `WhatsaapWeb-JS/src/services/security/SecretVault.ts`.
- `WhatsaapWeb-JS/src/services/audit/AuditLogger.ts`.
- `WhatsaapWeb-JS/src/services/diagnostics/DiagnosticDoctor.ts`.
- `WhatsaapWeb-JS/src/db/migrations/030_create_audit_events_and_secrets.sql`.
- `scripts/backup-rehearsal.sh`, `scripts/sbom-generate.sh`.
- `Frontend_py_whatsaapweb/src/pages/Admin/` (Auditoría, Usuarios, Conexiones y Salud).

#### 4. Tareas técnicas concretas
1. **Cifrado Envelope de Secrets (`SecretVault`):**
   - Implementar cifrado AES-256-GCM para todas las credenciales de canales y claves BYOK en base de datos.
   - Soporte de Clave Maestra segregada de la base de datos (variable de entorno o KMS externo).
   - Sanitización absoluta: Ningún token ni secreto aparece jamás en respuestas JSON de API ni en archivos de log.
2. **Pistas de Auditoría Append-Only (`audit_events`):**
   - Tabla `audit_events` inmutable (permisos de base de datos impiden `UPDATE` y `DELETE`).
   - Registro de actor, recurso, acción, decisión de política, IP, agente de usuario y huella de traza (`trace_id`).
3. **Herramienta Diagnóstica (`DiagnosticDoctor`, `PROD-014`, `WAA-020`):**
   - Verificaciones automáticas de conectividad de base de datos, permisos de webhooks, validez de certificados TLS y estado de cuotas de APIs externas con códigos estandarizados (`CH-WA-001`, `DB-PG-002`) y capacidad de diagnóstico y replay autorizado (`PROD-014`).
4. **Ensayo de Backup y Restauración Automatizado (`PROD-015`, `SEC-010`, `WAA-022`):**
   - Script determinista que crea volcado de PostgreSQL y metadatos de almacenamiento, los restaura en un contenedor de prueba efímero y ejecuta una suite de verificación de integridad de datos (`restore rehearsal` guiado, `PROD-015`).
5. **Auditoría de Licencias, SBOM y Edición Comunitaria (`PROD-011`, `ADR-017`, `ADR-018`, `SEC-012`, `WAA-024`):**
   - Pipeline de CI con `license-checker` que bloquea cualquier dependencia bajo licencias AGPL, GPL estricta o código comercial propietario en la versión Community Edition (CE).
   - Smoke test de verificación sin licencias externas para garantizar autosuficiencia comunitaria (`PROD-011`) y soberanía self-hosted (`ADR-017`).
   - Generación automática de SBOM en formato CycloneDX/SPDX.
6. **Auditoría Formal de Hipótesis de Fork de Terceros (WAA-025):**
   - Inspección forense de compatibilidad de licencias, deuda técnica y seguridad de repositorios candidatos (ChatbotX, Flowise, Activepieces) antes de cualquier adopción de código.

#### 5. Definición y alcance de PRs
- **`PR-F8-01`**: `feat(security): implement envelope encryption for credentials, OIDC SSO and append-only audit trail (WAA-023, SEC-006, SEC-011, ADR-013, ADR-021)`.
- **`PR-F8-02`**: `feat(sre): implement diagnostic doctor CLI/UI and automated disaster recovery restore rehearsal (WAA-020, WAA-022, PROD-014, PROD-015, SEC-010)`.
- **`PR-F8-03`**: `chore(compliance): enforce 100% MIT license check in CI, generate SBOM, CE smoke verification and complete third-party audit (WAA-024, WAA-025, PROD-011, SEC-012, ADR-017, ADR-018, ADR-024)`.

#### 6. Agentes responsables
- Ingeniero de Confiabilidad del Sitio (SRE), Oficial de Seguridad y Compliance, Auditor de Arquitectura.

#### 7. Trabajos paralelizables
- Los ensayos de SRE y backup (`PR-F8-02`) pueden ejecutarse en paralelo con el cifrado y auditoría en backend (`PR-F8-01`).

#### 8. Estrategia y cobertura de pruebas
- Pruebas de rotación de claves maestras: Verificación de descifrado y recifrado exitoso de credenciales almacenadas.
- Prueba de inmutabilidad de auditoría: Intentos de ejecutar `UPDATE audit_events` o `DELETE FROM audit_events` son rechazados con error de permisos a nivel de base de datos.
- Ensayo de restauración de backup: Ejecución automatizada en pipeline de CI demostrando 0% pérdida de integridad referencial.
- Escaneo de licencias: Detección y rechazo automático de librerías contaminadas con AGPL.

#### 9. Criterios de aceptación objetivos
- 100% de credenciales sensibles almacenadas cifradas con AES-256-GCM.
- Ensayo de restauración de desastre ejecutado con éxito en contenedor limpio.
- Reporte SBOM generado sin ninguna violación de licencia MIT en la distribución abierta.
- Diagnóstico `automat doctor` reporta 0 advertencias críticas en entorno de producción.

---

### Fase F9 — Expansión de Ecosistema y Clientes Móviles Nativos (WAA-026..028, PROD-018, PROD-019, ADR-023) [PLANNED — P3 EXPANDIDO]

#### 1. Objetivos de la fase
- Incorporar canales adicionales de mensajería (TikTok Business Messaging y LINE Official Account).
- Desarrollar las aplicaciones móviles nativas para Android e iOS (React Native / Expo) enfocadas en la operación de Inbox.
- Publicar el SDK oficial en lenguaje Python y el catálogo de extensiones comunitarias (Marketplace abierto).

#### 2. Funcionalidades abarcadas
- `WAA-026` (P3): Adaptadores de canal para TikTok y LINE.
- `WAA-027` (P3): Aplicaciones móviles nativas Android e iOS.
- `WAA-028` (P3): SDK oficial en Python y registro comunitario de extensiones.
- `PROD-018`, `PROD-019`: Movilidad operativa y expansión de ecosistema de desarrolladores.
- `ADR-023`: Decisión normativa de clientes móviles.

#### 3. Módulos afectados
- `packages/channel-tiktok/`, `packages/channel-line/` (Nuevos adaptadores).
- `apps/mobile/` (Nuevo proyecto React Native / Expo).
- `packages/python-sdk/` (Nuevo cliente Python tipado).
- `WhatsaapWeb-JS/src/services/marketplace/MarketplaceRegistry.ts`.

#### 4. Tareas técnicas concretas
1. **Adaptadores Omnicanal Adicionales:**
   - Desarrollar `TikTokAdapter` y `LineAdapter` implementando la interfaz `ChannelAdapterV1` de la Fase F0/F2.
2. **Aplicaciones Móviles Nativas (React Native / Expo):**
   - Creación de aplicación móvil orientada a agentes de atención:
     * Autenticación segura con almacenamiento biométrico de credenciales (Keychain/Keystore).
     * Sincronización en tiempo real vía WebSockets tenant-scoped y notificaciones push (FCM / APNs).
     * Gestión de Inbox: Lectura de conversaciones, envío de mensajes y notas internas, y takeover CAS.
3. **SDK en Python:**
   - Desarrollar cliente tipado (`whatsap-automat-sdk`) compatible con Python 3.10+ y tipado Pydantic v2.
4. **Catálogo Comunitario de Extensiones (Marketplace Abierto):**
   - Registro público para descubrimiento e instalación de conectores validados por la comunidad.

#### 5. Definición y alcance de PRs
- **`PR-F9-01`**: `feat(channels): implement TikTok Business Messaging and LINE Official Account adapters`.
- **`PR-F9-02`**: `feat(mobile): build React Native/Expo operations mobile app for iOS and Android`.
- **`PR-F9-03`**: `feat(ecosystem): create official Python SDK and community extension registry`.

#### 6. Agentes responsables
- Desarrollador Mobile (React Native), Ingeniero de Integraciones Python, Desarrollador de Canales.

#### 7. Trabajos paralelizables
- Los tres PRs de esta fase son completamente independientes entre sí y pueden ser ejecutados concurrentemente por equipos especializados.

#### 8. Estrategia y cobertura de pruebas
- Pruebas E2E de la app móvil en emuladores Android e iOS (Detox / Maestro).
- Pruebas unitarias del SDK Python contra fixtures de la API OpenAPI v1.
- Pruebas de integración de webhooks de TikTok y LINE contra sus entornos de sandbox oficiales.

#### 9. Criterios de aceptación objetivos
- Agentes de atención pueden responder chats y tomar control de conversaciones desde sus dispositivos móviles con notificaciones push instantáneas (<2s de latencia).
- Paquete Python publicado y verificable mediante `pytest` e integración en monorepo.
- Adaptadores de TikTok y LINE procesan eventos canónicos sin modificar el núcleo del sistema.

---

## 5. Tabla de Resumen de Fases y Dependencias Técnicas

| Fase | Título de la Fase | Entregables Clave | Dependencias Previas | Estado | Prioridad |
|---|---|---|---|---|---|
| **F0** | Consolidación y Verificación de Línea Base | Integración de PR-00..07, QA y UX; 163 pruebas pasando; main intacta | Ninguna | **DONE** | P0 |
| **F1** | Seguridad de Sockets, Tenancy y RLS en BD | Socket.IO JWT auth, PostgreSQL RLS, jerarquía Tenant/Workspace | F0 | **PLANNED** | **P0 (Inmediata)** |
| **F2** | Modelo Canónico, Capacidades y Outbox | CloudEvents v1, CapabilityRegistry, ProcessingOutbox, tokens UI | F1 | **PLANNED** | P1 |
| **F3** | Operación Conversacional, Inbox y CAS | CAS concurrency epoch, Meta Cloud/IG, Telegram, Webchat, Inbox 4-paneles | F2 | **PLANNED** | P1 |
| **F4** | Orquestación Duradera y Workflows sin Canal | Bridge Temporal OSS, Automation Studio, flujos inmutables y UC-06 | F3 | **PLANNED** | P1 |
| **F5** | Agentes Autónomos y ToolBroker | ModelGateway BYOK, ToolBroker (SSRF/RBAC/HITL), Agent Studio, RAG | F4 | **PLANNED** | P1 |
| **F6** | Canales Asíncronos, Campañas y Consentimiento | Segmentación, ConsentRecord, campañas throttled, Email SMTP/IMAP | F3, F4 | **PLANNED** | P1 |
| **F7** | Developer Platform y Sandboxing | OpenAPI v1, SDKs (@whatsap-automat/*), CLI automat, sandbox plugins | F5 | **PLANNED** | P1 / P2 |
| **F8** | Hardening Empresarial, SRE y Cumplimiento | Doctor CLI, backups verificados, envelope encryption, auditoría MIT/SBOM | F6, F7 | **PLANNED** | P2 |
| **F9** | Expansión y Clientes Móviles Nativos | TikTok, LINE, App React Native/Expo, Python SDK, Marketplace | F8 | **PLANNED** | P3 |

---

## 6. R5: Recomendación Técnica Fundamentada de la Primera Fase de Ejecución

Concluida la evaluación integral de la arquitectura, la auditoría del repositorio y el análisis de dependencias técnicas, se formula de manera formal e indiscutible la siguiente recomendación:

### **Designación Oficial: La Fase F1 (Seguridad de Sockets, Tenancy y Row-Level Security en Base de Datos) DEBE SER la primera fase técnica de ejecución tras la aprobación de este Roadmap.**

### Justificación Técnica y Criterio de Riesgo:

1. **Mitigación de Vulnerabilidad Crítica P0 en Capa de Tiempo Real (`socketHandler.js`):**
   - El archivo actual `WhatsaapWeb-JS/src/sockets/socketHandler.js` constituye una **falla de seguridad de severidad crítica** en producción.
   - Cualquier cliente sin autenticar puede abrir una conexión WebSocket y recibir de inmediato el evento `chats-updated` con la totalidad de los chats y números telefónicos de todos los clientes y empresas alojadas en el sistema.
   - Permite que cualquier socket se suscriba a cualquier conversación (`socket.on("join", chatId)`) sin validar que pertenezca al usuario o tenant.
   - Permite que cualquier cliente invoque `socket.on("logout")`, provocando el cierre intempestivo de la sesión de mensajería del servidor.
   - Construir nuevas funcionalidades de canales, automatizaciones o bandejas de entrada sin cerrar previamente este vector de fuga masiva de datos violaría los principios fundamentales de seguridad por diseño.

2. **Garantía de Aislamiento de Datos mediante Defensa en Profundidad (PostgreSQL RLS):**
   - Actualmente, la seguridad multitenant reside exclusivamente en la correcta escritura de sentencias SQL dentro del middleware `resourceAuth.ts` en la capa de aplicación.
   - En las 22 migraciones existentes de PostgreSQL, **ninguna tabla tiene activado Row-Level Security (`ENABLE ROW LEVEL SECURITY`)**.
   - Si un desarrollador o nuevo agente omite inadvertidamente la cláusula `AND company_id = $x` al implementar una nueva funcionalidad (por ejemplo, en el Outbox, en los canales o en los workflows), se generaría de inmediato una vulnerabilidad IDOR a nivel de motor de base de datos.
   - Activar RLS en la Fase F1 establece una barrera criptográfica y de base de datos a prueba de fallos: toda consulta que carezca de contexto transaccional válido del tenant retornará cero filas de manera fail-closed, protegiendo a la plataforma contra cualquier error humano futuro.

3. **Invariante Arquitectónico de Tenancy antes de Extender el Modelo de Datos:**
   - La jerarquía de datos establecida en el Blueprint v1.0 (`Tenant` -> `Workspace` -> `company_id`) debe quedar formalizada en el esquema de base de datos antes de crear las tablas de Outbox (F2), Canales (F3), Workflows (F4) o Agentes (F5).
   - Crear tablas en fases posteriores usando únicamente la columna legacy `company_id` obligaría a costosas y complejas migraciones de datos posteriores. Establecer el esquema correcto en la Fase F1 garantiza que todas las tablas subsiguientes nazcan blindadas con las claves foráneas de tenancy apropiadas.

**Conclusión:** La Fase F1 no añade complejidad prematura; establece los cimientos mínimos indispensables de seguridad, autenticación y aislamiento multitenant sin los cuales es técnicamente inviable y legalmente riesgoso operar un sistema empresarial.

---

## 7. Protocolo de Verificación e Integridad del Repositorio

Para auditar y validar de forma independiente el cumplimiento estricto de las restricciones del proyecto (cero modificaciones de código de aplicación, no merges a main y aprobación previa de roadmap), ejecute las siguientes instrucciones en el workspace:

### 7.1 Verificación de Integridad de Código y Git
```bash
# 1. Comprobar que no existen archivos modificados en la aplicación
git status --short
# Resultado esperado: Solo debe aparecer como untracked docs/architecture/ROADMAP_V1.0.md y .agents/

# 2. Confirmar que no se han tocado líneas de código en Frontend o Backend
git diff --stat origin/integration/v0.4-consolidated
# Resultado esperado: 0 archivos modificados en Frontend_py_whatsaapweb y WhatsaapWeb-JS

# 3. Confirmar que la rama main permanece exactamente en el commit 69ac388
git rev-parse main
# Salida esperada: 69ac388536a38bf070e1a09a1295e855060f96dd

# 4. Confirmar que el commit HEAD de integration/v0.4-consolidated es 0d9542e
git rev-parse HEAD
# Salida esperada: 0d9542ee539f42eedc68b7af2589b1684ff43b0e
```

### 7.2 Verificación de la Línea Base de Pruebas (163/163 Tests PASS)
```bash
# 1. Pruebas de Contratos Compartidos (64 tests)
npm test --prefix packages/contracts

# 2. Pruebas de Backend y Suites de Seguridad (94 tests)
npm test --prefix WhatsaapWeb-JS

# 3. Pruebas de Spike Temporal OSS (5 tests)
npm test --prefix spikes/temporal

# 4. Compilación de Frontend React (Build limpio)
npm run build --prefix Frontend_py_whatsaapweb
```

---
*Fin del Documento Normativo `ROADMAP_V1.0.md`.*
