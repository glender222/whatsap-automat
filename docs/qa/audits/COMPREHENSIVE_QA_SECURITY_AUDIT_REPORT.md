# REPORTE MAESTRO DE AUDITORÍA DE CALIDAD, SEGURIDAD Y TESTING DE SISTEMAS DISTRIBUIDOS / AGENTES DE IA (V0.4)

**Proyecto:** Whatsap-Automat  
**Rol:** Principal QA Engineer, Security Test Engineer & Specialist in Distributed Systems / AI Agents  
**Rama de Auditoría:** `comprehensive_qa_security_audit` (originada desde `main` en SHA `69ac388`)  
**Fecha:** 30 de Octubre de 2026  
**Documentos Base Analizados:**
1. `docs/architecture/BLUEPRINT_v0.4.md`
2. `docs/roadmap/PR_ROADMAP.md`
3. `docs/qa/QA_GATES_AND_CASES.md`
4. `docs/orchestration/README.md`

---

## 1. Resumen Ejecutivo

Como Principal QA Engineer y Security Specialist, se realizó una auditoría técnica, exhaustiva e independiente sobre la base de código actual (`WhatsaapWeb-JS` y `Frontend_py_whatsaapweb`). El objetivo fue identificar brechas de calidad, vectores de explotación, riesgos de concurrencia y ausencia de controles distribuidos antes de que avancen las ramas paralelas del roadmap v0.4.

### Dictamen General
El sistema cuenta con cimientos operativos valiosos (particularmente en el loop de herramientas de IA, sanitización de trazas y persistencia básica de Meta Cloud API con 45 pruebas unitarias passing). Sin embargo, **presenta vulnerabilidades críticas P0 en el perímetro de seguridad**:
1. **Socket.IO carece de autenticación en el handshake:** cualquier cliente sin credenciales puede conectarse, recibir la lista completa de chats de todos los inquilinos, escuchar mensajes de salas ajenas e inducir un `logout` que apaga el servicio WhatsApp globalmente (Vulnerabilidades críticas **SEC-02** y **SEC-08**).
2. **Autenticación HTTP Fail-Open:** Si no se activan flags de entorno opcionales, peticiones sin token acceden a recursos protegidos de WhatsApp/Media, y tokens válidos sin el claim de empresa son asignados silenciosamente al inquilino `defaultCompanyId=1` (Vulnerabilidades críticas **SEC-01** y **SEC-03**).
3. **Ausencia total de Row-Level Security (RLS):** Las 22 migraciones existentes (000 a 021) no activan RLS ni definen políticas de base de datos; la conexión del backend no establece el contexto de inquilino `app.current_tenant_id` (Vulnerabilidades críticas **SEC-04** y **SEC-05**).
4. **Idempotencia y Durabilidad Incompleta:** La ayuda de idempotencia actual genera números aleatorios sin almacenamiento ni verificación; el webhook ejecuta el modelo de lenguaje de forma síncrona en el proceso web sin un outbox transaccional (Vulnerabilidades **MSG-01**, **MSG-02** y **MSG-03**).
5. **Frontend con Deuda Técnica y Dependencias Contaminadas:** El `package.json` del frontend contiene librerías de servidor (`express`, `cors`, `whatsapp-web.js`) y dos archivos binarios corruptos en la raíz (`recovered_*.tsx`) que provocan 239 errores en ESLint, aunque `vite build` compila con éxito.

Para garantizar la reproducibilidad científica de estos hallazgos, **se diseñó, implementó y ejecutó exitosamente una nueva suite automatizada de 27 pruebas de seguridad en TypeScript** (`docs/qa/audits/suites/`), confirmando cada brecha sin alterar una sola línea de código productivo.

---

## 2. Auditoría Detallada por Dimensión

### 2.1 Autenticación (JWT, Roles y Permisos)
- **Archivos Auditados:** `WhatsaapWeb-JS/src/middleware/jwtAuth.ts`, `authMiddleware.js`, `src/config/index.ts`.
- **Hallazgos:**
  - `resolveWhatsappCompanyId(req)` (L69-78 de `jwtAuth.ts`) realiza una resolución permisiva con cascada hacia `config.defaultCompanyId || 1`.
  - La verificación `config.security.whatsappApiRequireCompanyClaim` es opcional y depende de `process.env.WHATSAPP_API_REQUIRE_COMPANY_CLAIM === 'true'`. En caso de estar inactiva (valor por defecto), un usuario malicioso de la Empresa B con un token que omita el claim de empresa adquiere privilegios sobre la Empresa 1.
  - `optionalWhatsappJwt` (L47-53 de `jwtAuth.ts`) asigna `req.whatsappCompanyId = config.defaultCompanyId || 1` y llama a `next()` cuando `WHATSAPP_API_REQUIRE_JWT` no es `'true'`.
- **Impacto:** Falla la gate **SEC-03** y abre la puerta a escalada de privilegios horizontal.

### 2.2 Aislamiento Multiempresa y RLS
- **Archivos Auditados:** `WhatsaapWeb-JS/src/db/migrations/` (000 a 021), `src/config/database.ts`, `src/shared/PgUnitOfWork.ts`.
- **Hallazgos:**
  - Se inspeccionaron las 22 migraciones SQL. **Cero migraciones ejecutan `ENABLE ROW LEVEL SECURITY` o `CREATE POLICY`**.
  - La conexión global `pool` en `database.ts` no ejecuta `SET LOCAL app.current_tenant_id = $1` al abrir transacciones.
  - Cualquier query en repositorios que contenga una omisión involuntaria en la cláusula `WHERE company_id = ...` devolverá datos cross-tenant.
- **Impacto:** Incumple **SEC-04**, **SEC-05** y **SEC-07**. Requiere la migración `022_` y el patrón `TenantScopedUoW` en **PR-03**.

### 2.3 Socket.IO y Tiempo Real
- **Archivos Auditados:** `WhatsaapWeb-JS/src/sockets/socketHandler.js`, `socketEmitter.ts`, `Frontend_py_whatsaapweb/src/utils/socket.ts`.
- **Hallazgos:**
  - En `socketHandler.js`, no se registra ningún middleware `io.use(...)` para autenticar la conexión. El backend descarta el `auth: { token }` que el cliente de frontend envía en `src/utils/socket.ts` (L33-35).
  - Al conectarse cualquier cliente (incluso sin token), `socket.emit("chats-updated", this.whatsappService.getChats())` transmite todos los chats de todas las empresas.
  - El handler `socket.on("join", (chatId) => socket.join(chatId))` une al socket a cualquier sala sin verificar si el `chatId` pertenece a su empresa.
  - En `socketEmitter.ts`, la función `emitDashboard` llama a `ioInstance.emit(...)`, transmitiendo eventos privados (creación de pagos, cambios de stock, sugerencias del agente) en broadcast global hacia todos los navegadores conectados.
  - En `socketHandler.js` (L48-63), el evento `logout` llama a `this.whatsappService.logout()` sin autenticación de rol admin, permitiendo que cualquier usuario corte la sesión WhatsApp del servidor completo.
- **Impacto:** Vulnerabilidades críticas **SEC-02** y **SEC-08**.

### 2.4 Webhooks (Meta Cloud API)
- **Archivos Auditados:** `WhatsaapWeb-JS/src/routes/metaWebhookRoutes.ts`, `src/services/whatsappService.ts`, `src/services/whatsapp/meta/MetaCloudClient.ts`.
- **Evaluación Positiva:**
  - La verificación de firma HMAC SHA-256 sobre el `req.rawBody` está bien implementada en `MetaCloudClient.verifySignature` y se invoca antes de procesar el body.
  - El endpoint valida `phone_number_id` y rechaza IDs desconocidos con código `404` (`META_WEBHOOK_TENANT_NOT_FOUND`), evitando el uso de la empresa por defecto (Cumple **MSG-05**).
  - Si un wamid entrante ya fue persistido (`persisted.duplicate === true`), se cancela la ejecución del agente y no se reenvía mensaje (Cumple **MSG-01** en flujo estándar).

### 2.5 Idempotencia y Durabilidad
- **Archivos Auditados:** `WhatsaapWeb-JS/src/core/application/helpers/idempotency.helper.ts`.
- **Hallazgos:**
  - `generateClientRequestId()` y `generateIdempotencyKey()` son meros generadores de cadenas basadas en `Date.now() + Math.random()`. No consultan tablas de base de datos ni validan llaves previas.
  - La recepción y respuesta ocurren en un flujo síncrono monoproceso. Si el contenedor se reinicia después de persistir el mensaje pero antes de invocar la IA, el mensaje queda desatendido sin reintento duradero (**MSG-02**).
  - Si el servidor se cae tras invocar a la API de Meta pero antes de guardar la traza, no existe reconciliación y el sistema queda en estado incierto (**MSG-03**).
- **Impacto:** Se requiere urgentemente el Transactional Outbox (**PR-06**) y el bridge a Temporal (**PR-08**).

### 2.6 Ejecución de Agentes e IA
- **Archivos Auditados:** `WhatsaapWeb-JS/src/modules/ai/application/AgentToolRuntimeLoop.ts`, `AgentToolRegistry.ts`, `AgentToolExecutor.ts`.
- **Evaluación Positiva:**
  - Se respetan límites de seguridad contra bucles infinitos: `MAX_TOOL_ROUNDS = 4` y `MAX_TOOL_CALLS_PER_MESSAGE = 8` (**RUN-01**).
  - La sanitización de trazas en `AgentToolLogger` oculta credenciales y prompts completos.
  - Errores de ejecución interna son enmascarados con el código seguro `TOOL_EXECUTION_ERROR_CODE` (`TOOL_ERROR_INTERNAL`), impidiendo la fuga de información sensible al modelo.

### 2.7 Workflows y Máquina de Estados
- **Archivos Auditados:** `WhatsaapWeb-JS/src/modules/ai/application/AgentPauseService.ts`, `AgentHandoffService.ts`, `OrderService.ts`.
- **Hallazgos:**
  - La pausa de IA (`isConversationPaused`) funciona correctamente impidiendo auto-respuestas si un operador humano ha tomado el control.
  - Sin embargo, si dos mensajes de clientes llegan en paralelo al mismo milisegundo para la misma conversación, no existe bloqueo distribuido ni serialización en base de datos (**MSG-06**), pudiendo disparar dos ejecuciones paralelas de LLM.

### 2.8 Aprobaciones (HITL - Human-in-the-Loop)
- **Archivos Auditados:** `WhatsaapWeb-JS/src/db/migrations/012_ai_commercial_catalog.sql`, `OrderRepositoryPg.ts`.
- **Hallazgos:**
  - Existe el flag `requires_human_approval` en los items de catálogo y el estado `pending_approval` en órdenes.
  - No obstante, la cola de aprobaciones duradera con timeout, cancelación por expiración (**RUN-07**) y control de concurrencia optimista mediante CAS (**RUN-08**) aún no existe; debe implementarse en **PR-11**.

### 2.9 Seguridad de Herramientas (Tool Guardrails & Sandboxing)
- **Archivos Auditados:** `AgentToolExecutor.ts`, `AgentToolRegistry.ts`.
- **Evaluación Positiva:**
  - Las herramientas de pago (`payment.createLink`, `payment.validateVoucher`) están estrictamente deshabilitadas (`disabled_future_tool`) y cualquier intento de cobro o pago redirige automáticamente a `handoff.create` con motivo `payment_closure` (**RUN-04**).
  - En modo `isTest = true`, las herramientas de mutación retornan `{ dryRun: true, reason: 'sandbox_no_mutation' }` sin alterar el estado en base de datos (**RUN-12**).
  - La matriz de modos (`normal`, `mixed`, `automator`) bloquea herramientas de escritura en modo asistido/mixto con status `forbidden` (**RUN-03**).

### 2.10 Regresiones y Seguridad de Frontend
- **Archivos Auditados:** `Frontend_py_whatsaapweb/src/shared/axios/http.ts`, `src/utils/socket.ts`, `package.json`.
- **Hallazgos:**
  - **Seguridad en HTTP:** `http.ts` inyecta correctamente `Bearer ${token}` y cuenta con cola de suscriptores para refresh de tokens en respuestas 401 evitando avalanchas concurrentes.
  - **Llamadas directas a Meta:** Se verificó que el cliente NO llama a `graph.facebook.com`; toda la comunicación fluye por el backend propio.
  - **Contaminación de Dependencias:** `Frontend_py_whatsaapweb/package.json` incluye `express`, `cors`, `body-parser` y `whatsapp-web.js`.
  - **Archivos Corruptos en Raíz:** Existen dos archivos binarios corruptos en la raíz del frontend (`recovered_SettingsModal.tsx` y `recovered_useSocketSimple.tsx`) que generan errores de parseo y rompen la ejecución de ESLint (239 errores).

---

## 3. Inventario y Categorización Estricta de Pruebas

Para dar estricto cumplimiento a la instrucción de auditoría:
> *"Distingue pruebas ya existentes, pruebas que realmente ejecutaste y pruebas todavía propuestas."*

Presentamos el inventario exhaustivo en tres categorías independientes:

```
┌────────────────────────────────────────────────────────────────────────┐
│                   INVENTARIO DE PRUEBAS DE CALIDAD                     │
├─────────────────────────┬──────────────────────────┬───────────────────┤
│  A. Pruebas Existentes  │  B. Pruebas Ejecutadas   │  C. Pruebas       │
│     en el Baseline      │     Realmente por QA     │     Propuestas    │
│       (45 tests)        │        (72 tests)        │   (Roadmap v0.4)  │
└─────────────────────────┴──────────────────────────┴───────────────────┘
```

### Categoría A: Pruebas ya existentes en el baseline
Ubicadas en `WhatsaapWeb-JS/src/test/`:
1. `meta-webhook-p0.test.ts` (8 pruebas): verificación de firma HMAC, challenge, phone_number_id y deduplicación de wamid.
2. `multiagent-routing-p0.test.ts` (12 pruebas): enrutamiento de intenciones (atención al cliente, ventas, inventario, pedidos) y fallback de agentes.
3. `openai-provider-p0.test.ts` (3 pruebas): compatibilidad con OpenAI Responses API y OpenCode.
4. `p0-handoff-idempotency.test.ts` (4 pruebas): reutilización de handoff activo, túnel y variables de entorno.
5. `p0-safe-runtime.test.ts` (3 pruebas): sanitización de logs y captura de errores internos de herramientas.
6. `tools-reales-ia.test.ts` (15 pruebas): especificación SPEC-HU15 (búsqueda de catálogo, verificación de stock, bloqueo de pagos y handoff).
*Total existente en repositorio:* **45 pruebas**.

### Categoría B: Pruebas que REALMENTE ejecutamos en esta auditoría
Ejecutadas en este entorno y verificadas empíricamente:

1. **Suite Heredada Completa (Backend):**
   - Comando: `cd WhatsaapWeb-JS && npm test`
   - Resultado: **45 pruebas ejecutadas, 45 pasadas, 0 fallidas** (1,331 ms).
2. **Validación de Tipos Backend:**
   - Comando: `cd WhatsaapWeb-JS && npm run typecheck` (`tsc --noEmit`)
   - Resultado: **0 errores de TypeScript**.
3. **Validación de Compilación Frontend:**
   - Comando: `cd Frontend_py_whatsaapweb && npm run build` (`tsc -b && vite build`)
   - Resultado: **Build exitoso en 11.46s**. Chunks generados en `dist/`.
4. **Validación de Calidad / Linter Frontend:**
   - Comando: `cd Frontend_py_whatsaapweb && npm run lint` (`eslint .`)
   - Resultado: **255 problemas (239 errores, 16 warnings)**. Causa identificada: archivos binarios corruptos `recovered_*.tsx` y tipos `any`.
5. **Nuevas Suites de Seguridad y Auditoría QA (Preparadas y Ejecutadas por Nosotros):**
   - Ubicación: `docs/qa/audits/suites/`
   - Comando: `cd WhatsaapWeb-JS && npx tsx --test ../docs/qa/audits/suites/*.test.ts`
   - Desglose de resultados:
     - `auth-multitenant-rls.test.ts` (7 pruebas): **7 PASS, 0 FAIL** (Valida SEC-01, SEC-03, SEC-04 y SEC-07).
     - `socketio-security.test.ts` (5 pruebas): **5 PASS, 0 FAIL** (Valida SEC-02, SEC-08 y broadcast leaks).
     - `webhook-idempotency.test.ts` (4 pruebas): **4 PASS, 0 FAIL** (Valida MSG-01, MSG-04, MSG-05 y falta de outbox).
     - `agent-runtime-tool-security.test.ts` (6 pruebas): **6 PASS, 0 FAIL** (Valida RUN-01, RUN-03, RUN-04, RUN-12 y sanitización).
     - `frontend-contracts-security.test.ts` (5 pruebas): **5 PASS, 0 FAIL** (Valida contratos cliente, interceptores y dependencias).
   - Resultado total de auditoría nueva: **27 pruebas ejecutadas, 27 pasadas, 0 fallidas** (422 ms).

*Total de pruebas automatizadas ejecutadas y validadas por nosotros:* **72 pruebas (45 heredadas + 27 de auditoría)**.

### Categoría C: Pruebas propuestas (Roadmap de implementación)
Pruebas que deben construirse e incorporarse en los PRs correspondientes a medida que los agentes paralelos desarrollen los componentes:
1. **Pruebas de RLS con Roles PostgreSQL Reales (PR-03):** Contenedor de pruebas ejecutando scripts SQL como usuario `app_runtime` para verificar que `SELECT * FROM conversations` retorne 0 filas sin `SET LOCAL app.current_tenant_id` (**SEC-04**).
2. **Pruebas de Recuperación y Replay de Temporal (PR-07 & PR-08):** Inyección de `SIGKILL` en el worker durante la ejecución de una actividad de envío y verificación de reanudación determinista sin repetir efectos (**RUN-09**, **MSG-02**).
3. **Pruebas de Concurrencia de Aprobaciones CAS (PR-11):** Dos solicitudes concurrentes de aprobación sobre el mismo ticket con versiones desfasadas para certificar que el motor rechace la segunda (**RUN-08**).
4. **E2E Browser Testing con Playwright (PR-16 & PR-18):** Flujo completo de login, visualización de Inbox omnicanal, takeover humano (pausa de IA) y envío de mensajes en navegadores reales (**UX-05**).
5. **Pruebas de Adversarial Prompt Injection (PR-10 & PR-12):** Dataset de evaluación con ataques de inyección indirecta intentando extraer claves API o forzar descuentos comerciales no parametrizados (**RUN-04**).

---

## 4. Guía de Trabajo y Reglas de Desarrollo Paralelo

Dado que múltiples agentes de Antigravity trabajan simultáneamente en worktrees independientes originados desde el mismo SHA `69ac388`:

1. **Aislamiento de Archivos de Auditoría:**  
   Esta sesión limitó todas sus escrituras exclusivamente al directorio `docs/qa/audits/`. No se tocó ningún archivo de código productivo ni se modificaron contratos pendientes.
2. **Uso de Mocks Documentados:**  
   Las 27 pruebas de seguridad se diseñaron de manera autónoma utilizando stubs y verificaciones de esquema/código para comprobar vulnerabilidades sin colisionar con el trabajo de los agentes de `fix_jwt_auth_p0` (PR-01) o `implement_shared_contracts_pr04` (PR-04).
3. **Matriz de Conflictos Potenciales y Dependencias:**
   - **PR-01 (Auth P0):** Debe eliminar el fallback a `defaultCompanyId` en `jwtAuth.ts` y hacer obligatorio el claim de empresa. Al fusionarse, nuestra suite `auth-multitenant-rls.test.ts` servirá de gate inmediata.
   - **PR-02 (Socket.IO):** Debe migrar `socketHandler.js` a TypeScript con middleware `io.use(socketAuthMiddleware)` e implementar rooms con formato `company_${id}:chat_${id}`.
   - **PR-04 (Contratos):** Al entregar `packages/contracts`, se debe actualizar la suite para validar esquemas Zod unificados.
   - **PR-06 (Outbox):** Creará la tabla `outbox` transaccional en migración `024_`, cerrando la vulnerabilidad **MSG-02**.

---

## 5. Handoff de Auditoría QA

```markdown
# Handoff: SESSION_05 / QA_INDEPENDENT_AUDIT
- Rama: comprehensive_qa_security_audit
- Base SHA: 69ac388
- Archivos creados / modificados:
  * docs/qa/audits/COMPREHENSIVE_QA_SECURITY_AUDIT_REPORT.md
  * docs/qa/audits/RISK_REGISTER_V04.md
  * docs/qa/audits/ACCEPTANCE_CRITERIA_PER_PR.md
  * docs/qa/audits/suites/auth-multitenant-rls.test.ts
  * docs/qa/audits/suites/socketio-security.test.ts
  * docs/qa/audits/suites/webhook-idempotency.test.ts
  * docs/qa/audits/suites/agent-runtime-tool-security.test.ts
  * docs/qa/audits/suites/frontend-contracts-security.test.ts
- Implementación verificada:
  * Auditoría completa de los 11 dominios arquitectónicos.
  * Identificación y confirmación reproducible de 12 riesgos de seguridad/calidad.
  * Creación y ejecución de 27 pruebas automatizadas de seguridad.
  * Criterios de aceptación detallados para PR-00 a PR-21 vinculados a los casos del Blueprint v0.4.
- Pruebas ejecutadas y resultados exactos:
  * WhatsaapWeb-JS npm test: 45 tests pasados (1,331 ms).
  * WhatsaapWeb-JS npm run typecheck: 0 errores.
  * Frontend npm run build: compilación limpia en 11.46s.
  * Frontend npm run lint: 255 problemas detectados (evidencia documentada).
  * QA Security Audit Suites (27 tests): 27 tests pasados (422 ms).
- Pruebas no ejecutadas y motivo:
  * Pruebas de integración con PostgreSQL real bajo rol app_runtime (requiere instancia DB en ejecución con migración 022_ de PR-03).
  * Temporal replay tests (depende del stack de PR-07/PR-08).
- Hallazgos de seguridad y compatibilidad:
  * Brechas críticas en Socket.IO (handshake auth ausente, room hijacking, global logout).
  * Fail-open en JWT con fallback silencioso a empresa 1.
  * Ausencia de RLS en todas las migraciones vigentes.
  * Contaminación de dependencias de servidor en frontend package.json.
- Estado: READY_FOR_REVIEW
```
