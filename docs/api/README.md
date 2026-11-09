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
| `GET` | `/api/v1/conversations/{id}` | Detalle de conversación | `Authorization` |
| `GET` | `/api/v1/conversations/{id}/messages` | Mensajes de conversación | `Authorization` |
| `POST` | `/api/v1/conversations/{id}/messages` | Envío de mensaje humano (previsto) | `Authorization`, `Idempotency-Key` |
| `POST` | `/api/v1/conversations/{id}/takeover` | Handoff y toma de control (CAS) | `Authorization` |
| `POST` | `/api/v1/conversations/{id}/pause-ai` | Pausa de IA conversacional (CAS) | `Authorization` |
| `POST` | `/api/v1/conversations/{id}/resume-ai` | Reanudar IA conversacional (CAS) | `Authorization` |
| `GET` | `/api/v1/channel-connections` | Conexiones y salud | `Authorization` |
| `POST` | `/api/v1/channel-connections/{id}/validate` | Diagnóstico sin secretos | `Authorization` |
| `GET` | `/api/v1/agent-graphs` | Listar borradores por tenant | `Authorization`, rol `ADMIN` |
| `POST` | `/api/v1/agent-graphs` | Crear borrador de grafo | `Authorization`, rol `ADMIN` |
| `GET` | `/api/v1/agent-graphs/{id}` | Leer una revisión guardada | `Authorization`, rol `ADMIN` |
| `POST` | `/api/v1/agent-graphs/{id}/revisions` | Guardar una nueva revisión inmutable | `Authorization`, rol `ADMIN` |
| `POST` | `/api/v1/agent-graphs/{id}/validate` | Validar la estructura de una revisión guardada | `Authorization`, rol `ADMIN` |
| `POST` | `/api/v1/agent-graphs/{id}/publish` | Publicación bloqueada (HTTP 501) | `Authorization`, rol `ADMIN` |
| `POST` | `/api/v1/agent-runs/simulate` | Simulación en sandbox (dry-run) | `Authorization` |
| `GET` | `/api/v1/agent-runs/{id}/trace` | Traza auditada de ejecución | `Authorization` |
| `POST` | `/api/v1/workflows/{id}/publish` | Activar una revisión identificada | `Authorization` |
| `POST` | `/api/v1/workflows/{id}/rollback` | Restaurar una revisión publicada con motivo de auditoría | `Authorization` |
| `GET` | `/api/v1/approvals` | Cola de aprobaciones pendientes | `Authorization` |
| `GET` | `/api/v1/approvals/{id}` | Estado y parámetros redactados | `Authorization` |
| `POST` | `/api/v1/approvals/{id}/decision` | Decisión de aprobación (CAS) | `Authorization`, `Idempotency-Key` |
| `GET` | `/api/v1/operations/executions` | Historial de soporte y reintentos | `Authorization` |

El contrato incluye operaciones previstas. En la API v1 de conversaciones se pueden consultar la lista, el detalle y el historial, además de tomar el control, pausar o reanudar la IA. Los cambios CAS identifican al operador con su sesión. La lista y el historial devuelven primero los registros de mayor identificador. En conversaciones migradas del esquema anterior, `connectionId` usa una referencia de compatibilidad `legacy:<tenant>:<canal>`.

Agent Studio conserva cada borrador como una revisión numerada e inmutable. Para leer o validar una revisión anterior, indica `?version=N`. La validación comprueba la estructura sin ejecutar el grafo y devuelve `publicationEvidence: false`. El simulador de regresión de `/api/v1/ai/eval/simulate` devuelve resultados sintéticos. La publicación requiere ejecutar una evaluación de servidor con un conjunto de pruebas autorizado, asociar su evidencia al tenant, la revisión y su hash, y usar esa revisión exacta en el runtime.

## 4. Marketplace comunitario

Las rutas usan el prefijo `/api/v1/marketplace`.

| Método y ruta | Acceso | Resultado |
|---|---|---|
| `GET /extensions` | Público | Catálogo paginado y puntuaciones agregadas. |
| `GET /extensions/{id}` | Público | Metadatos de una extensión publicada. |
| `POST /validate` | Público | Validación de manifiesto y comprobación SHA-256 si se proporcionan los bytes y el hash. |
| `POST /extensions` | Administrador autenticado | Registra o actualiza la extensión de su empresa. Si otra empresa ya registró el identificador o el nombre, devuelve `409`. |
| `POST /extensions/{id}/rate` | Usuario autenticado | Crea o reemplaza la puntuación del usuario en su empresa. |
| `GET /extensions/{id}/ratings` | Usuario autenticado | Reseñas y puntuaciones de su empresa. |

La migración `034_marketplace_catalog.sql` crea el catálogo y las reseñas en PostgreSQL. Los nombres e identificadores se reservan en la transacción que publica la extensión. Cada usuario puede mantener una puntuación por extensión y empresa. PostgreSQL actualiza los totales públicos en la misma transacción y restringe el acceso a las reseñas detalladas por empresa mediante RLS. `GET /health` devuelve `503` si el catálogo no puede consultar su almacenamiento.

El registro empieza vacío y las publicaciones comunitarias aparecen sin verificar. El editor aloja por separado los archivos de descarga en HTTPS. El servidor usa los bytes enviados para comprobar o calcular el hash y guarda los metadatos en PostgreSQL. La instalación de extensiones desde este catálogo requiere integración con el runtime.

Para ejecutar las pruebas de PostgreSQL, usa una base aislada con las migraciones aplicadas y un rol sin `SUPERUSER` ni `BYPASSRLS`. Las pruebas crean empresas y publicaciones en esa base. Configura `MARKETPLACE_TEST_DATABASE_URL` y ejecuta desde `WhatsaapWeb-JS`:

```bash
node --import tsx --test src/test/marketplace-registry.test.ts src/test/marketplace-postgres.test.ts
```
