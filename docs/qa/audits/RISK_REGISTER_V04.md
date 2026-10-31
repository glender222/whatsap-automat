# REGISTRO DE RIESGOS DE SEGURIDAD, CALIDAD Y ARQUITECTURA (V0.4)

**Fecha de Auditoría:** 30 de Octubre de 2026  
**Auditor:** Principal QA Engineer & Security Test Specialist  
**Estado del Repositorio:** `main` (SHA verificado: `69ac388`)  
**Clasificación:** Confidencial / Auditoría Interna de Arquitectura  

---

## 1. Matriz Resumen de Riesgos

| ID | Riesgo / Vulnerabilidad | Severidad | CVSS v3.1 | Módulo / Archivo Afectado | PR de Mitigación | Estado |
|---|---|---|---|---|---|---|
| **RSK-01** | **Bypass de autenticación en Socket.IO y robo de eventos** | **CRÍTICA** | **9.1** (CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N) | `WhatsaapWeb-JS/src/sockets/socketHandler.js` | **PR-02** | Confirmado en Auditoría |
| **RSK-02** | **Denegación de servicio global vía Socket.IO `logout`** | **CRÍTICA** | **8.6** (CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:N/I:N/A:H) | `WhatsaapWeb-JS/src/sockets/socketHandler.js` (L48-63) | **PR-02** | Confirmado en Auditoría |
| **RSK-03** | **Fuga masiva cross-tenant vía `emitDashboard` global** | **ALTA** | **8.2** (CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:N/A:N) | `WhatsaapWeb-JS/src/sockets/socketEmitter.ts` (L9-16) | **PR-02** | Confirmado en Auditoría |
| **RSK-04** | **Fail-open en JWT y fallback a `defaultCompanyId=1`** | **CRÍTICA** | **8.8** (CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H) | `WhatsaapWeb-JS/src/middleware/jwtAuth.ts` (L31, L76) | **PR-01** | Confirmado en Auditoría |
| **RSK-05** | **Acceso anónimo a rutas de chat, multimedia y perfiles** | **ALTA** | **7.5** (CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N) | `WhatsaapWeb-JS/src/app.ts` (L200-240) | **PR-01** | Confirmado en Auditoría |
| **RSK-06** | **Ausencia total de Row-Level Security (RLS) en base de datos** | **ALTA** | **7.4** (CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:N) | `WhatsaapWeb-JS/src/db/migrations/` (000 a 021) | **PR-03** | Confirmado en Auditoría |
| **RSK-07** | **Inexistencia de Outbox transaccional y pérdida por caída** | **ALTA** | **7.1** (CVSS:3.1/AV:A/AC:L/PR:N/UI:N/S:U/C:N/I:H/A:H) | `WhatsaapWeb-JS/src/core/application/helpers/idempotency.helper.ts` | **PR-06** | Confirmado en Auditoría |
| **RSK-08** | **Acoplamiento síncrono del runtime de IA en Webhook Meta** | **MEDIA** | **5.9** (CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:L/A:H) | `WhatsaapWeb-JS/src/services/whatsappService.ts` (L586-630) | **PR-08** | Confirmado en Auditoría |
| **RSK-09** | **Falta de motor durable de aprobaciones (HITL)** | **MEDIA** | **5.4** (CVSS:3.1/AV:N/AC:L/PR:L/UI:R/S:U/C:N/I:H/A:N) | `WhatsaapWeb-JS/src/modules/orders/infra/db/OrderRepositoryPg.ts` | **PR-11** | Confirmado en Auditoría |
| **RSK-10** | **Dependencias de backend en package.json de frontend** | **BAJA** | **3.8** (CVSS:3.1/AV:L/AC:L/PR:N/UI:N/S:U/C:N/I:L/A:N) | `Frontend_py_whatsaapweb/package.json` | **PR-00 / PR-16** | Confirmado en Auditoría |
| **RSK-11** | **Fallo masivo de Lint en frontend por binarios corruptos** | **MEDIA** | **4.2** (CVSS:3.1/AV:L/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L) | `Frontend_py_whatsaapweb/recovered_*.tsx` | **PR-00** | Confirmado en Auditoría |
| **RSK-12** | **CORS permisivo (`*`) por defecto en backend** | **MEDIA** | **5.3** (CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N) | `WhatsaapWeb-JS/src/config/index.ts` (L113) | **PR-00 / PR-01** | Confirmado en Auditoría |

---

## 2. Detalle y Vectores de Explotación por Riesgo

### RSK-01 / RSK-02 — Socket.IO: Ausencia de Handshake Auth & Desconexión Global
- **Causa Raíz:** `socketHandler.js` no implementa `io.use(socketAuthMiddleware)` ni valida el JWT que el cliente web ya envía en `auth.token`. Al recibir conexión, emite inmediatamente `chats-updated` con todos los chats del sistema sin filtro de empresa.
- **Vector de Ataque:**
  1. Un atacante se conecta a `ws://<host>:<port>/socket.io/?EIO=4&transport=websocket`.
  2. Recibe en el evento `chats-updated` los chats de todas las empresas.
  3. Emite `join` con el chatId de otra empresa y escucha en tiempo real todos los mensajes entrantes (`on('message')`).
  4. Emite `logout` y desconecta el cliente de WhatsApp del servidor para todos los inquilinos.
- **Criterio de Cierre PR-02:** Rechazar conexiones sin JWT válido con `401 Unauthorized`. Namespace obligatorio en rooms `company_${companyId}:chat_${chatId}`. Eliminar handler `logout` desprotegido.

### RSK-04 / RSK-05 — JWT: Fail-Open & Exposición de Recursos WhatsApp
- **Causa Raíz:** En `jwtAuth.ts`, `resolveWhatsappCompanyId()` contiene el fallback `toPositiveInt(user.companyId) || ... || config.defaultCompanyId || 1`. Además, `config.security.whatsappApiRequireCompanyClaim` y `config.security.whatsappApiRequireJwt` están condicionados a flags de entorno que en `.env.example` están apagados o ausentes.
- **Vector de Ataque:**
  1. Un usuario del inquilino B cuyo JWT no incluya `companyId` (o que llame sin token a `/api/chats` o `/api/media/:id`) es enrutado automáticamente a la empresa 1.
  2. Puede consultar el histórico de conversaciones, descargar audios/imágenes confidenciales y alterar pedidos de la empresa 1.
- **Criterio de Cierre PR-01:** Fail-closed estricto. Token sin `companyId` o `tenantId` válido debe responder `403 Forbidden` inmediatamente, sin fallback a empresa 1. Eliminar `optionalWhatsappJwt` de rutas de producción.

### RSK-06 — PostgreSQL: Inexistencia de RLS en Migraciones 000-021
- **Causa Raíz:** Las 22 migraciones SQL existentes crean tablas con columna `company_id`, pero ninguna tabla activa `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`. El backend se conecta con el superusuario/owner `postgres` sin establecer `SET LOCAL app.current_tenant_id`.
- **Impacto:** Si cualquier endpoint, reporte o consulta comete una omisión en el `WHERE company_id = $1` o realiza un `JOIN` no acotado, los datos de todos los inquilinos quedan expuestos.
- **Criterio de Cierre PR-03:** Aplicar migración `022_` que active RLS en tablas críticas (`messages`, `conversations`, `contacts`, `orders`, `catalog_items`, `agent_runtime_logs`). Ejecución bajo rol restringido (`app_runtime`) que no pueda hacer bypass de RLS.

### RSK-07 / RSK-08 — Idempotencia Inexistente y Acoplamiento Síncrono
- **Causa Raíz:** `idempotency.helper.ts` genera IDs aleatorios temporales (`Math.random()`) sin persistencia ni validación de estado previo. En `whatsappService.ts`, el webhook de Meta procesa la recepción, persistencia, enrutamiento semántico, ejecución de LLM y envío de respuesta en el mismo ciclo síncrono HTTP.
- **Impacto:** Caída de red o reinicio del contenedor durante la inferencia provoca pérdida silenciosa del mensaje (sin retry). Reinicio tras envío al proveedor pero antes del ACK en base de datos genera reenvíos duplicados al usuario final de WhatsApp.
- **Criterio de Cierre PR-06 & PR-08:** Migración `024_` con tabla `outbox` transaccional. Ingesta atómica `(inbound_message + outbox_intent)`. Desacoplar ejecución del agente hacia workflows durables con Temporal.
