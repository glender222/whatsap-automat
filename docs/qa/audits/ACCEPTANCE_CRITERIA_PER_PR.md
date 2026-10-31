# CRITERIOS DE ACEPTACIÓN Y QA GATES POR PULL REQUEST (PR-00 A PR-21)

**Autor:** Principal QA & Security Test Engineer  
**Documento Fuente:** Whatsap-Automat Blueprint v0.4 (§13 & §14)  
**Objetivo:** Establecer condiciones innegociables de revisión, comandos ejecutables, evidencias obligatorias y planes de rollback para cada PR en el desarrollo paralelo.

---

## 1. Reglas Generales de Aprobación de PR (Definition of Done)

Para que cualquier PR sea declarado `READY_FOR_REVIEW` y fusionable:
1. **Compilación Estricta:**
   - Backend: `npm run typecheck` y `npm run build` con código de salida `0`.
   - Frontend: `npm run build` (`tsc -b && vite build`) con código de salida `0`.
2. **Suite de Pruebas Automatizada:**
   - La suite de pruebas de regresión debe ejecutarse y terminar en verde (`pass 100%`).
   - Nuevos endpoints o mutaciones deben incorporar pruebas unitarias y de integración deterministas (sin llamadas a redes externas ni secretos reales).
3. **Aislamiento de Scope (Desarrollo Paralelo):**
   - El diff debe tocar únicamente los archivos del ownership asignado en `docs/orchestration/README.md`.
   - Cero dependencias inventadas o contratos divergentes de `packages/contracts`.
4. **Seguridad Multi-Tenant:**
   - Cero leaks cross-tenant. Toda nueva tabla o consulta debe incluir scope de `company_id`.

---

## 2. Matriz de Gates por Pull Request

### OLA 0 — BASELINE, SEGURIDAD Y ENTORNO DE CONTRIBUCIÓN

#### PR-00 — Baseline reproducible, documentación, licencia y CI mínimo
- **Responsabilidad:** Coordinador de Proyecto.
- **Ownership de Archivos:** Raíz, `LICENSE`, `.github/workflows`, metadatos `package.json`, `.gitignore`, `CONTRIBUTING.md`, `SECURITY.md`.
- **Casos de Aceptación Requeridos:**
  - `OSS-01`: Docker compose / stack base reproducible sin API keys reales.
  - `OSS-03`: `npm test` heredado en verde y documentado.
- **Comandos de Verificación:**
  ```bash
  cd WhatsaapWeb-JS && npm test
  cd ../Frontend_py_whatsaapweb && npm run build
  ```
- **Criterio de Rechazo Inmediato:**
  - Presencia de secretos en `.env.example` o en commits.
  - Modificación de código de negocio en `src/app.ts` o `src/services/`.
- **Rollback:** Revertir commits de CI/documentación. No impacta base de datos.

---

#### PR-01 — Fail-Closed JWT y Claims/Permissions
- **Responsabilidad:** Ingeniero de Seguridad Backend.
- **Ownership de Archivos:** `WhatsaapWeb-JS/src/middleware/jwtAuth.ts`, `authMiddleware.js`, `src/config/index.ts`, fixtures de auth.
- **Casos de Aceptación Requeridos:**
  - `SEC-01`: Tenant A intentando acceder a recursos (chats, media, perfiles) de Tenant B recibe `403` o `404`; cero fuga de datos.
  - `SEC-03`: Petición con JWT sin claim `companyId`/`tenantId` recibe `401` o `403` inmediatamente sin fallback a `defaultCompanyId=1`.
  - Acceso anónimo a `/api/whatsapp`, `/api/chats`, `/api/media` rechazado con `401`.
- **Comandos de Verificación:**
  ```bash
  cd WhatsaapWeb-JS && npx tsx --test ../docs/qa/audits/suites/auth-multitenant-rls.test.ts
  ```
- **Rollback:** Restaurar commit previo con feature flag para sandbox local si fuera necesario; jamás activar fallback público en producción.

---

#### PR-02 — Socket Authentication y Tenant Rooms
- **Responsabilidad:** Ingeniero Backend / Realtime.
- **Ownership de Archivos:** `WhatsaapWeb-JS/src/sockets/socketHandler.ts`, `socketEmitter.ts`, `src/utils/socket.ts`.
- **Casos de Aceptación Requeridos:**
  - `SEC-02`: Cliente de Tenant A intenta unirse a sala de Tenant B; denegado, 0 eventos recibidos. Conexión sin token JWT rechazada en el handshake.
  - `SEC-08`: Evento `logout` desprotegido eliminado de Socket.IO. La desconexión solo procede por ruta HTTP autorizada con rol `admin`.
  - `emitDashboard` reemplazado por `emitTenant(companyId, event, data)`. Cero broadcast global `io.emit()` de información de inquilinos.
- **Comandos de Verificación:**
  ```bash
  cd WhatsaapWeb-JS && npx tsx --test ../docs/qa/audits/suites/socketio-security.test.ts
  ```
- **Rollback:** Cambiar exclusivamente consumidores compatibles; no reactivar emisión global.

---

#### PR-03 — DB Tenant Audit + RLS Pilot
- **Responsabilidad:** Especialista en Bases de Datos / Backend.
- **Ownership de Archivos:** `WhatsaapWeb-JS/src/db/migrations/022_*.sql`, `TenantScopedUoW.ts`, role matrix.
- **Casos de Aceptación Requeridos:**
  - `SEC-04`: Conexión PostgreSQL ejecutada bajo rol restringido (`app_runtime`) sin tenant context (`SET LOCAL app.current_tenant_id`) devuelve 0 filas y deniega escritura.
  - `SEC-05`: Rol runtime no puede asumir permisos `BYPASS RLS` ni superusuario.
  - `SEC-07`: Inserción con FK `conversation_id` perteneciente a otra empresa es rechazada por política RLS o constraints compuestas `(id, company_id)`.
- **Comandos de Verificación:**
  ```bash
  npm run db:status
  npm run db:migrate
  ```
- **Rollback:** Desactivar enforcement de RLS mediante migración reversible sin borrar datos legacy.

---

### OLA 1 — DURABILIDAD Y CONTRATOS

#### PR-04 — Packages/contracts + OpenAPI v1 + Mocks
- **Responsabilidad:** Diseñador de Contratos / Core Architect.
- **Ownership de Archivos:** `packages/contracts/`, esquemas Zod/JSON Schema, OpenAPI spec v1, mocks sintéticos.
- **Casos de Aceptación Requeridos:**
  - `CH-01`: Tipos contractuales compartidos compilan sin error tanto en frontend como en backend.
  - Esquema de eventos unificado (`inbound_message`, `channel_event`, `agent_decision`, `approval_request`).
- **Comandos de Verificación:**
  ```bash
  npm run typecheck --prefix packages/contracts
  ```
- **Rollback:** Paquete aislado, puede revertirse sin tocar el runtime actual.

---

#### PR-05 — Channel Connection Registry e Identidad Separada
- **Responsabilidad:** Backend Engineer (Canales).
- **Ownership de Archivos:** Migración `023_channel_connections.sql`, adaptadores de conexión, lookup de capacidades.
- **Casos de Aceptación Requeridos:**
  - `CH-01`: Adaptador Meta actual migrado al registry sin colisión.
  - `MSG-05`: `phone_number_id` desconocido rechazado con 404/400; nunca se asocia a la empresa por defecto.
  - Dos números Meta distintos de dos empresas diferentes procesados simultáneamente sin mezcla de contexto.
- **Rollback:** Rollback de lecturas con feature flag; tablas nuevas se conservan expand-only.

---

#### PR-06 — Transactional Inbox/Outbox e Idempotencia
- **Responsabilidad:** Distributed Systems Engineer.
- **Ownership de Archivos:** Migración `024_inbox_outbox.sql`, `TransactionalInboxService`, `TransactionalOutboxRelay`.
- **Casos de Aceptación Requeridos:**
  - `MSG-01`: Mensaje inbound con wamid duplicado genera 1 sola intención lógica de procesamiento en el outbox.
  - `MSG-02`: Caída forzada del proceso tras el commit en base de datos pero antes de la ejecución del agente; el relay reanuda el procesamiento sin pérdida.
  - `MSG-03`: Caída tras enviar a Meta pero antes de confirmar ACK en base de datos marca estado `unknown_delivery` para reconciliación en vez de reintento ciego.
- **Comandos de Verificación:**
  ```bash
  cd WhatsaapWeb-JS && npx tsx --test ../docs/qa/audits/suites/webhook-idempotency.test.ts
  ```
- **Rollback:** Desactivar outbox relay mediante flag manteniendo eventos encolados de forma segura.

---

#### PR-07 — Temporal Spike + Stack Reproducible
- **Responsabilidad:** DevOps / Temporal Specialist.
- **Ownership de Archivos:** `deploy/temporal/`, `compose.demo.yaml`, workflows de prueba y workers de spike.
- **Casos de Aceptación Requeridos:**
  - `OSS-01`: Temporal server + PostgreSQL + UI ejecutable con `docker compose` sin licencias de pago.
  - Replay test con server temporal local simulando avance rápido de tiempo (`time skipping`).
  - Worker restart y reanudación de timers de workflow.
- **Rollback:** Detener contenedores Docker; sin impacto en producción.

---

#### PR-08 — Bridge Outbox → Temporal + Workflow Durable
- **Responsabilidad:** Distributed Systems Engineer.
- **Ownership de Archivos:** Bridge outbox-worker, `conversationWorkflow`, starter idempotente.
- **Casos de Aceptación Requeridos:**
  - `MSG-06`: Dos mensajes entrantes concurrentes en el mismo chat son secuenciados por el workflow sin duplicar respuestas ni respuestas en desorden.
  - `RUN-09`: Asesinato de proceso worker (`kill -9`) en mitad de una actividad; Temporal reasigna la tarea y continúa sin repetir efectos secundarios mutantes.
- **Rollback:** Pausar nuevo dispatch de workflows y drenar ejecuciones pendientes.

---

### OLA 2 — HARNESS Y SEGURIDAD OPERACIONAL

#### PR-09 — Agent Graph Schema / Compiler / Versioning
- **Responsabilidad:** AI Systems Engineer.
- **Ownership de Archivos:** Migración `025_agent_graphs.sql`, graph compiler, validadores de ciclos y permisos.
- **Casos de Aceptación Requeridos:**
  - `RUN-01`: Grafo con ciclo infinito rechazado por el compilador o terminado por presupuesto de pasos.
  - `RUN-10`: Múltiples versiones de grafos en paralelo; los chats en vuelo ejecutan con la versión congelada del inicio del turno.
- **Comandos de Verificación:**
  ```bash
  cd WhatsaapWeb-JS && npx tsx --test src/test/multiagent-routing-p0.test.ts
  ```

---

#### PR-10 — Dynamic Agent Graph Scheduler
- **Responsabilidad:** AI Systems Engineer.
- **Ownership de Archivos:** Node dispatch scheduler, ledger de costo, branch/join controllers.
- **Casos de Aceptación Requeridos:**
  - `RUN-02`: Fan-out de múltiples ramas limitado por concurrency cap del tenant.
  - `RUN-11`: Presupuesto de tokens/costo excedido dispara hard-stop y fallback a handoff humano.
  - `RUN-12`: Sandbox de simulación (`ctx.isTest = true`) ejecuta herramientas en modo dry-run sin alterar inventario ni crear órdenes reales.
- **Comandos de Verificación:**
  ```bash
  cd WhatsaapWeb-JS && npx tsx --test ../docs/qa/audits/suites/agent-runtime-tool-security.test.ts
  ```

---

#### PR-11 — Policy / Approval Engine
- **Responsabilidad:** Security & AI Engineer.
- **Ownership de Archivos:** `approval_requests`, Temporal Signals, CAS (Compare-And-Swap) evaluators.
- **Casos de Aceptación Requeridos:**
  - `RUN-03`: Invocación de herramienta sin permisos rechazada con `POLICY_DENIED`.
  - `RUN-04`: Prompt injection intentando ordenar pago directo es interceptado y deriva a aprobación obligatoria.
  - `RUN-05`: Handoff tomado por humano mientras el modelo infiere invalida automáticamente la auto-respuesta en vuelo.
  - `RUN-07`: Solicitud de aprobación expirada por timeout; se cancela sin ejecutar el efecto y registra auditoría.
  - `RUN-08`: Aprobación enviada concurrentemente por dos operadores; CAS rechaza la segunda como conflicto de versión.

---

#### PR-12 — Multi-Provider Model Gateway (BYOK / Managed)
- **Responsabilidad:** Platform Engineer.
- **Ownership de Archivos:** Gateway de modelos, encriptación de claves tenant, quotas y streaming cancel.
- **Casos de Aceptación Requeridos:**
  - `RUN-11`: Fallos de proveedor (429 Rate Limit, 500 o Timeout) gestionados con fallback determinista.
  - Cero claves API o tokens de LLM en logs (`0 token in logs`).

---

#### PR-13 — Memoria por Identidad/Canal + Privacy Controls
- **Responsabilidad:** AI Data Engineer.
- **Ownership de Archivos:** Tablas de memoria semántica, filtros de retención, API de purga.
- **Casos de Aceptación Requeridos:**
  - `MEM-01`: Misma persona física en dos canales o dos empresas distintas; ninguna fusión de memorias ni cruce de datos.
  - `MEM-02`: Solicitud de borrado (derecho al olvido / GDPR) elimina resúmenes, embeddings y datos en caché.

---

### OLA 3 — CANALES Y EXPERIENCIA

#### PR-14 & PR-15 — Adaptadores Telegram, Instagram y Messenger
- **Responsabilidad:** Integrations Engineer.
- **Ownership de Archivos:** Conectores de canal, validadores de webhook secrets, capability registry.
- **Casos de Aceptación Requeridos:**
  - `CH-01`: Contract tests completos para los adaptadores.
  - `CH-02`: Token de canal revocado o expirado marca estado `needs_reauthorization` y alerta al operador.
  - `CH-03`: Canal sin soporte interactivo oculta botones del composer en UI.
  - `MSG-04`: Webhook de Telegram con secret token incorrecto rechazado con `403`.

---

#### PR-16 — Workspace Web e Inbox Omnicanal
- **Responsabilidad:** Frontend Engineer.
- **Ownership de Archivos:** `Frontend_py_whatsaapweb/src/`, Inbox omnicanal, composer adaptativo.
- **Casos de Aceptación Requeridos:**
  - `UX-05`: Navegación completa por teclado y accesibilidad (a11y) en Inbox y acciones críticas.
  - `SEC-01` & `SEC-02`: Comprobación en cliente de desconexión inmediata al expirar JWT y aislamiento estricto de eventos por empresa.
  - Cero dependencias de servidor en `Frontend_py_whatsaapweb/package.json`.
- **Comandos de Verificación:**
  ```bash
  cd Frontend_py_whatsaapweb && npm run build && npm run lint
  ```

---

#### PR-17 & PR-18 — Agent Studio Visual, Simulador y Aprobaciones
- **Responsabilidad:** Frontend & Fullstack Engineer.
- **Ownership de Archivos:** Editor de grafos, inspector de pasos, simulador dry-run, cola de aprobaciones.
- **Casos de Aceptación Requeridos:**
  - `UX-01`: Creación de workflow guiada por asistente y prueba en simulador con cero efectos reales.
  - `UX-02`: Publicación de grafo valida advertencias de bucles, costos y diff de versiones.
  - `UX-03`: Aprobación humana con vista previa de impacto y confirmación antes de la ejecución.

---

### OLA 4 — MÓVIL, RELEASE Y ESTABILIZACIÓN

#### PR-19 & PR-20 — Mobile Foundation, Inbox y Aprobaciones Push
- **Responsabilidad:** Mobile Engineer (React Native / Expo).
- **Ownership de Archivos:** `apps/mobile/`, secure storage, deep links, push handlers.
- **Casos de Aceptación Requeridos:**
  - Build Android/iOS instalable generado en CI.
  - Cero PII (información personal sensible) en el payload de notificaciones push.
  - `UX-03`: Deep link a aprobación con autenticación biométrica y resolución vía CAS.
  - `UX-04`: Reconexión offline sin duplicar mensajes en cola ni silenciar notificaciones.

---

#### PR-21 — Hardening, Self-Hosted Productivo y Release Final
- **Responsabilidad:** Principal QA & Security Engineer + Release Manager.
- **Ownership de Archivos:** Scripts de backup/PITR, multi-tenant soak tests, SBOM, release notes.
- **Casos de Aceptación Requeridos:**
  - `100%` de casos P0 (seguridad, aislamiento, idempotencia) aprobados en CI.
  - `0` vulnerabilidades críticas abiertas.
  - `OPS-01`: Backup y restore exitoso de DB PostgreSQL y estado de Temporal con reconciliación de datos.
  - `OPS-02`: Prueba de soak/estrés con 2 tenants bajo carga asimétrica demostrando fairness y estabilidad.
  - `OSS-02`: Migración limpia (fresh database) produce esquema idéntico a la secuencia de migraciones incrementales.
