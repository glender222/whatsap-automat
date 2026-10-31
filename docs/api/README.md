# Especificación de API v1 — Whatsap-Automat (PR-04)

Este directorio contiene la especificación formal y documentación de la **API v1** para Whatsap-Automat, basada en **OpenAPI 3.1.0**, contratos canónicos compartidos y semántica de errores según **RFC 7807 / RFC 9457**.

---

## 1. Principios de Diseño

1. **Aislamiento Multi-tenant Obligatorio**:
   - Toda solicitud privada exige autenticación mediante JWT (`BearerAuth`).
   - El `tenantId` (asociado internamente a `company_id`) se resuelve exclusivamente a partir del token de sesión o credenciales verificadas del canal; **nunca** se confía en parámetros enviados por el cliente.
2. **Concurrencia Optimista (CAS - Compare-And-Swap)**:
   - Las operaciones de mutación concurrente (como `takeover` de conversaciones, `pause-ai` y aprobaciones) exigen el parámetro `expectedVersion`.
   - Si la versión en base de datos difiere de la esperada, la API responde inmediatamente con `409 Conflict`, evitando sobrescrituras silenciosas de estado.
3. **Idempotencia Transaccional**:
   - Envíos de mensajes y decisiones de aprobación requieren la cabecera `Idempotency-Key`.
   - La API asocia la clave con un efecto único (`effectKey`), garantizando que reintentos de red no generen duplicados en el proveedor ni mutaciones dobles en base de datos.
4. **Paginación por Cursor**:
   - Respuestas de listas (`/api/v1/conversations`, `/api/v1/conversations/{id}/messages`) utilizan cursores opacos (`nextCursor`, `prevCursor`) y límites estrictos, evitando el deterioro de rendimiento de `OFFSET/LIMIT`.
5. **Privacidad y Ocultamiento de Secretos**:
   - Endpoints de conexión (`/api/v1/channel-connections`) y trazas de ejecución (`/api/v1/agent-runs/{id}/trace`) redactan tokens, contraseñas y datos sensibles del proveedor.

---

## 2. Vocabulario Canónico de Errores (ProblemDetails)

Las respuestas de error siguen el estándar `application/problem+json` (RFC 7807 / RFC 9457):

| Código de Error | Código HTTP | Significado |
|---|---|---|
| `UNAUTHORIZED` | 401 | Sesión inexistente, token vencido o sin claim de tenant |
| `POLICY_DENIED` | 403 | Acción denegada por RBAC, tenant policy o límite de permisos |
| `APPROVAL_REQUIRED` | 428 / 403 | Acción de alto riesgo que requiere aprobación humana previa |
| `NOT_FOUND` | 404 | Recurso inexistente o no perteneciente al tenant autenticado |
| `CONFLICT` | 409 | Conflicto de versión concurrente (CAS) o clave de efecto duplicada |
| `VALIDATION_ERROR` | 422 | Carga útil rechazada por esquema de validación (`invalidParams`) |
| `RATE_LIMITED` | 429 | Exceso de solicitudes o rate limits del proveedor externo |
| `UNKNOWN_DELIVERY` | 502 | El proveedor externo no devolvió confirmación ni rechazo concluyente |
| `RETRYABLE` | 503 | Fallo transitorio recuperable mediante reintento con backoff |
| `INTERNAL_ERROR` | 500 | Error no controlado del servidor (sin exposición de stack traces) |

### Estructura de Error

```json
{
  "type": "https://api.whatsap-automat.internal/errors/conflict",
  "title": "Resource conflict or stale version",
  "status": 409,
  "detail": "Versión de estado obsoleta: esperado 3, actual 4. Recargue el recurso.",
  "instance": "/api/v1/conversations/conv_001/takeover",
  "code": "CONFLICT",
  "correlationId": "corr_wa_takeover_987",
  "metadata": {
    "expectedVersion": 3,
    "currentVersion": 4
  }
}
```

---

## 3. Catálogo de Endpoints v1

Consulte los archivos de especificación formal:
- Formato YAML: [`openapi.v1.yaml`](./openapi.v1.yaml)
- Formato JSON: [`openapi.v1.json`](./openapi.v1.json)

| Método | Ruta | Descripción | Cabeceras Relevantes |
|---|---|---|---|
| `GET` | `/api/v1/workspaces/current` | Espacio de trabajo y permisos | `Authorization` |
| `GET` | `/api/v1/conversations` | Lista paginada de conversaciones | `Authorization` |
| `GET` | `/api/v1/conversations/{id}/messages` | Mensajes de conversación | `Authorization` |
| `POST` | `/api/v1/conversations/{id}/messages` | Envío de mensaje humano | `Authorization`, `Idempotency-Key` |
| `POST` | `/api/v1/conversations/{id}/takeover` | Handoff y toma de control (CAS) | `Authorization` |
| `POST` | `/api/v1/conversations/{id}/pause-ai` | Pausa de IA conversacional (CAS) | `Authorization` |
| `GET` | `/api/v1/channel-connections` | Conexiones y salud | `Authorization` |
| `POST` | `/api/v1/channel-connections/{id}/validate` | Diagnóstico sin secretos | `Authorization` |
| `POST` | `/api/v1/agent-graphs` | Crear borrador de grafo | `Authorization` |
| `POST` | `/api/v1/agent-graphs/{id}/validate` | Lint y análisis estático | `Authorization` |
| `POST` | `/api/v1/agent-graphs/{id}/publish` | Publicar versión inmutable | `Authorization`, `If-Match` |
| `POST` | `/api/v1/agent-runs/simulate` | Simulación en sandbox (dry-run) | `Authorization` |
| `GET` | `/api/v1/agent-runs/{id}/trace` | Traza auditada de ejecución | `Authorization` |
| `POST` | `/api/v1/automation-definitions/{id}/publish` | Publicar regla de workflow | `Authorization` |
| `GET` | `/api/v1/approvals` | Cola de aprobaciones pendientes | `Authorization` |
| `POST` | `/api/v1/approvals/{id}/decision` | Decisión de aprobación (CAS) | `Authorization`, `Idempotency-Key` |
| `GET` | `/api/v1/operations/executions` | Historial de soporte y reintentos | `Authorization` |
