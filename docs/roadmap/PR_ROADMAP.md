# PR ROADMAP

## 14. Plan de implementación por pull requests (PRs) — diseñado para revisión incremental

**Regla:** 1 PR = 1 frontera clara; cada PR describe diff esperado, pruebas, rollback y dependencias. No integrar un bloque gigante. PRs de UX/API/móvil pueden avanzar en paralelo después de establecer contrato estable. Prefijos de ramas `feat/`, `fix/`, `docs/`, `test/`, `infra/`.

### Ola 0 — baseline, seguridad y entorno de contribución

**PR-00 — Baseline reproducible, documentación, licencia y CI mínimo**  
**Dep.:** ninguna. **Cambios:** `LICENSE` MIT tras verificar derechos/autores, metadata ISC->MIT, `.gitignore`, `.env.example` sin secrets, README estado real, `docs/architecture/BLUEPRINT_v0.4.md`, GitHub Actions lint/build/test, Dependabot equivalente opcional, `CONTRIBUTING`, `SECURITY`. **Aceptar:** CI base ejecutable y documentado; suite legacy reportada (si falla, issue con evidencia); no inclusión de secretos en historial nuevo. **Rollback:** solo CI/docs; no tocar DB. **Riesgo:** decisiones legales/third-party licenses.

**PR-01 — Fail-closed JWT y claims/permissions**  
**Dep.:** PR-00. **Cambios:** `jwtAuth.ts`, `app.ts`, `config/`, middlewares de recurso, fixtures auth; rutas legacy bajo auth estricta; demo fuera del endpoint productivo. **Aceptar:** SEC-01, SEC-03, media accesos; `defaultCompanyId` no usable para auth operativa. **Rollback:** feature flags solo para sandbox aislado, nunca fallback público. **Riesgo:** usuarios legacy sin claim; plan de migración claims.

**PR-02 — Socket authentication y tenant rooms**  
**Dep.:** PR-01. **Cambios:** `socketHandler.js` sustituido incrementalmente por TS autenticado, `socketEmitter.ts` con `emitTenant/emitConversation`, `src/utils/socket.ts` update; evitar `io.emit` de payload tenant; `logout` vía ruta autorizada. **Aceptar:** SEC-02/08; usuarios del tenant A no oyen B; rejoin tras reconnect con auth. **Rollback:** cambiar solo consumers compatibles con eventVersion; no reactivar emisión global.

**PR-03 — DB tenant audit + RLS pilot**  
**Dep.:** PR-01. **Cambios:** `TenantScopedUoW` y role matrix, migración `022_`, script auditoría de tablas/roles, RLS pilot sobre subset; transición de repositorios core. **Aceptar:** SEC-04/05/07 y queries sin contexto denegadas; data legacy preservada. **Rollback:** migración expand separada del enforcement; rollback documentado sin desactivar auth. **Riesgo:** SQL legacy `pool.query`, join de adjuntos, DB owner.

### Ola 1 — durabilidad y contratos

**PR-04 — Packages/contracts + OpenAPI v1 + mocks**  
**Dep.:** PR-00/01. **Cambios:** `packages/contracts`, schema validators, OpenAPI API v1, fixtures synthetic, error vocabulary; interfaces channel event, agent graph, approval. **Aceptar:** compile web/backend; contract tests sin red externa. **Rollback:** nuevo paquete aislado. **Riesgo:** evitar tipos divergentes.

**PR-05 — Channel Connection Registry e identidad separada**  
**Dep.:** PR-03/04. **Cambios:** migración `023_`, channel_connections/channel_identities, adaptador Meta actual, lookup de conexión, capability registry; backfill provisional con reporte de ambigüedad. **Aceptar:** 2 cuentas Meta sin mezcla, misma identidad textual en canales separada, CH-01 básico. **Rollback:** rollback de reads con feature flag; tablas nuevas se preservan. **Riesgo:** colisión de external_conversation_id y cuentas históricas.

**PR-06 — Transactional inbox/outbox e idempotencia**  
**Dep.:** PR-03/05. **Cambios:** migración `024_`, ingestión transaccional y processing relay stub, status + reconciliation; dejar IA legacy en modo sombra temporal. **Aceptar:** MSG-01/02/03, sin doble efecto en reinicio simulado; mapping de logs. **Rollback:** apagar nueva ruta por feature flag manteniendo eventos pendientes; replay seguro. **Riesgo:** doble consumo al habilitar rutas antiguas y nuevas simultáneamente.

**PR-07 — Temporal spike + stack reproducible**  
**Dep.:** PR-00/04. **Cambios:** `deploy/temporal`, `compose.demo.yaml`, health, workflow demo, worker, TLS/prod docs, test kill/replay; BD Temporal distinta. **Aceptar:** OSS-01 en entorno demo, spike de restart/timer, documentación de recursos. **Rollback:** no activar tráfico productivo. **Riesgo:** complejidad de infraestructura.

**PR-08 — Bridge outbox → Temporal + workflow durable**  
**Dep.:** PR-06/07. **Cambios:** starter idempotente, actividad `conversationWorkflow`, workflow IDs, correlation, reintentos, compensación; revalidar estado antes efectos. **Aceptar:** MSG-02/06 y RUN-09; caída server/worker recuperable. **Rollback:** detener nuevos starts, drenar/reconciliar runs pendientes, nunca borrar history sin backup. **Riesgo:** semántica “ack temprano” mal implementada.

### Ola 2 — harness y seguridad operacional

**PR-09 — Agent graph schema/compiler/versioning**  
**Dep.:** PR-04/08. **Cambios:** `025_` grafos/versiones/runs/nodes, schema compiler valida loops/edges/permissions, visual graph storage API. **Aceptar:** RUN-01/10, nodos inválidos no publican, ciclos permitidos con hard limits. **Rollback:** el loop actual sigue disponible con flag; no corromper sessions. **Riesgo:** versioning de definiciones largas.

**PR-10 — Dynamic Agent Graph Scheduler**  
**Dep.:** PR-09. **Cambios:** scheduler de node dispatch con Temporal, delegación, branches, joins, step counter, cost ledger, checkpoints, cancellation; adaptar tool executor. **Aceptar:** RUN-01/02/09/11 con test server; 2 tenants concurrentes. **Rollback:** grafo feature flagged, preservar state de runs. **Riesgo:** fan-out y deadlocks.

**PR-11 — Policy/Approval Engine**  
**Dep.:** PR-03/09/10. **Cambios:** `approval_requests`, policy evaluators, risk classes, Signals Temporal, CAS, UI mínima de aprobación, audit. **Aceptar:** RUN-03/04/05/06/07/08. **Rollback:** desactivar auto-acciones y conservar approvals; no permitir bypass. **Riesgo:** race con handoff.

**PR-12 — Multi-provider Model Gateway + BYOK/local/managed**  
**Dep.:** PR-03/09. **Cambios:** credential store cifrado, adaptador OpenAI/OpenCode existente, provider local, managed ledger, quotas, streaming/cancel donde factible. **Aceptar:** RUN-11, fallos auth/timeout/429, 0 token en logs y sin fallback indebido. **Rollback:** provider anterior bajo scope tenant, sin secrets globales salvo instancia administrada autorizada. **Riesgo:** SSRF/model local y costo.

**PR-13 — Memoria por identidad/canal + privacy controls**  
**Dep.:** PR-05/09/12. **Cambios:** memoria estructurada, resúmenes, TTL, source evidence, APIs de borrado/exportación. **Aceptar:** MEM-01/02, no mem cross channel. **Rollback:** desactivar retrieval, conservar datos para limpieza auditable. **Riesgo:** datos sensibles y cachés.

### Ola 3 — canales y experiencia

**PR-14 — Telegram adapter completo**  
**Dep.:** PR-05/06/08/11. **Cambios:** webhook secret, dedupe updateId, send, media/health, capability registry, wizard guiado. **Aceptar:** CH-01/02, MSG-04, mocks y sandbox controlado. **Rollback:** deshabilitar conexión nueva, drenar. **Riesgo:** rate limits y eventos fuera de orden.

**PR-15 — Instagram/Messenger adapters + validación Meta**  
**Dep.:** PR-05/06/08/11. **Cambios:** conectores separados con event parsing, Meta scopes, lifecycle/revoke, webhooks, capacidad por producto, wizards. **Aceptar:** CH-01/02/03; fixtures oficiales o capturas sanitizadas autorizadas. **Rollback:** feature flag por canal; no false connected. **Riesgo:** app review/permisos de Meta externos; puede quedar bloqueado hasta aprobación.

**PR-16 — Workspace Web e Inbox omnicanal**  
**Dep.:** PR-02/04/05; integra PR-11/14/15 progresivamente. **Cambios:** navegación, inbox por conexión, composer capabilities, estados, takeover UI, panel contexto; extraer componentes legacy sin big-bang rename. **Aceptar:** UX-05, SEC-01/02, E2E enviar/tomar/pausar; diseño móvil responsive. **Rollback:** rutas web existentes bajo feature flag. **Riesgo:** romper estado Jotai/socket.

**PR-17 — Agent Studio visual y simulador**  
**Dep.:** PR-09/10/11/12. **Cambios:** graph editor, inspector, historial versions, publish diff/validation, debug replay, sandbox; editor avanzado same schema. **Aceptar:** UX-02, RUN-12, keyboard/a11y. **Rollback:** revert UI sin eliminar specs/publicadas. **Riesgo:** UX compleja, canvas accessibility.

**PR-18 — Workflow templates/wizard, operaciones y aprobaciones**  
**Dep.:** PR-08/11/16. **Cambios:** definición declarativa, templates, asistente, dry-run, publicación, Operations timeline, approvals queue. **Aceptar:** UX-01/03, RUN-07/08; no canvas general requerido. **Rollback:** desactivar activación de nuevos workflows y conservar historial. **Riesgo:** triggers repetidos y reglas ambiguas.

### Ola 4 — móvil, release y estabilización

**PR-19 — Mobile foundation iOS/Android**  
**Dep.:** PR-04/01/02. **Cambios:** `apps/mobile`, auth/session, API SDK, navegación, secure storage, entorno self-host configurable, CI build dev Android/iOS. **Aceptar:** build nativo instalable, no tokens de proveedores en bundle, session revoked. **Rollback:** independiente de API web. **Riesgo:** firmas, minOS, dispositivos, distribución.

**PR-20 — Mobile Inbox, approvals y push**  
**Dep.:** PR-19/11/16. **Cambios:** Inbox, reply, takeover, approvals, push, deep links y cache/reconnect. **Aceptar:** UX-03/04; device tests; cero PII en push. **Rollback:** suspender push server-side, versiones API compatibles. **Riesgo:** background lifecycle y token expiration.

**PR-21 — Hardening, self-hosted productivo y stable release**  
**Dep.:** PR-01..20 + aprobación externa para canales aplicables. **Cambios:** backup/PITR, disaster recovery, multi-tenant chaos, rate limits, load tests, docs de despliegue/upgrade, SBOM, release notes, accessibility, APIs de diagnóstico. **Aceptar:** todas las gates de §13; OSS-01..03, OPS-01..02. **Rollback:** release tags/DB schema expand-only; conservar compatibilidad y restore probado. **Riesgo:** dependencia de revisión Meta y calidad de documentación externa.

### 14.1 Dependencias y paralelismo

```text
PR-00 ─┬─> PR-01 ─┬─> PR-02 ───────────> PR-16
       │         └─> PR-03 ─┬─> PR-05 ─┬─> PR-06 ─┬─> PR-08
       │                     │           │           │
       └─> PR-04 ────────────┘           └─> PR-14/15
       └─> PR-07 ───────────────────────────> PR-08
PR-08 + PR-04 ──> PR-09 ──> PR-10 ──> PR-11
PR-09 ──> PR-12 ──> PR-13
PR-09/10/11/12 ──> PR-17
PR-08/11/16 ──> PR-18
PR-01/02/04 ──> PR-19 ──> PR-20
PR-01..20 ──> PR-21
```

Carriles paralelos después de P0: `infra/Temporal`, `contracts/adapters`, `UX design system`, `mobile foundation`, `QA fixtures`. **No** adelantar integraciones externas antes de permisos, colas y scoping de tenant.

### 14.2 Definición de terminado por PR

Cada PR debe incluir: historia/ADR, diff acotado, migraciones expand/rollback cuando aplique, test unit/contract/integration, adversarial si riesgo, documentación API, feature flag si migración, observabilidad, instrucciones QA y evidencia CI. Reviewer de seguridad obligatorio para SQL-RLS/auth/Socket/keys; reviewer UX para flujos y a11y. El autor no puede autoaprobar una excepción P0.
