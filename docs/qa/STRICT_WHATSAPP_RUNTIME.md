# WhatsApp con revisión publicada y admisión strict

## Alcance del primer corte

La migración 062 conecta un agente publicado `provider / linear-text-v1` con el trabajo durable de un mensaje de texto de Meta. Es una llamada acotada al modelo con el prompt de la revisión y el texto exacto del inbound. Comparte las reservas y el libro de consumo de la empresa con evaluaciones y otras llamadas strict. No cambia automáticamente la política de una empresa, su modo operativo ni los agentes numéricos existentes.

Antes del cambio, la reproducción con dos empresas confirmó que Alfa podía completar una llamada acotada con cuota pero su siguiente mensaje de WhatsApp terminaba `skipped / AI_ADMISSION_UNAVAILABLE`; Bravo mantenía router, lectura de catálogo y respuesta con el proveedor anterior. La aserción de aceptación (`completed`) quedó roja. El corte nuevo permite esa respuesta sólo después de que un ADMIN vincule una publicación compatible. Sin vínculo permanece cerrado y nunca vuelve al proveedor anterior.

Este perfil no autoriza router, herramientas, delegaciones, historial libre ni la ejecución manual de un agente legacy. Esos recorridos siguen bloqueados en strict. Para ampliarlos hace falta un perfil evaluable que exprese mensajes assistant/tool, límites agregados de rondas y herramientas, y su propia compatibilidad de publicación; no se puede convertir silenciosamente una evaluación de texto en permiso para herramientas.

## Contrato administrativo

`/api/v1/ai/whatsapp-binding` exige JWT de ADMIN y usa exclusivamente el tenant del servidor. Las respuestas no se almacenan en caché.

| Operación | Entrada | Resultado |
| --- | --- | --- |
| GET | Sin parámetros | `200 {binding: null | binding}` |
| PUT | `{graphId, version, specHash, mode: "suggest" | "auto", expectedRevision: UUID | null}` | `200 {binding}` |
| DELETE | `{expectedRevision: UUID | null}` | `204` |

`binding` contiene `{revision, graphId, version, specHash, mode, boundBy, boundAt}`. `revision` es un UUID nuevo por cambio administrativo. `expectedRevision: null` representa ausencia observada. Las operaciones comparan esa revisión bajo el mismo bloqueo de PostgreSQL; una edición obsoleta devuelve `409` con `code: BINDING_CONFLICT`. Validación inválida devuelve `422`; sesión ausente o inválida `401`; EMPLEADO `403`. Publicación inexistente, ajena, incompatible o con huella distinta devuelve un conflicto genérico sin exponer datos de otro tenant.

PUT puede preparar el vínculo antes de activar strict. DELETE también funciona en pausa. Vincular v1 no hace que una publicación posterior de v2 cambie ese pin. Reemplazar o retirar explícitamente el vínculo invalida la autorización de salida de un turno anterior.

## Identidad, presupuesto y continuidad

1. El trabajo de entrada ya identifica tenant, UUID de outbox, mensaje interno y conversación. `prepare` valida esa fuente contra el texto original persistido y crea un único run/intento por inbound. Las mismas claves con otro texto, conversación o timeout no reutilizan el intento.
2. El run guarda versión, huella, revisión administrativa, modo y hash de petición. El timeout efectivo es el mínimo entre 30 segundos y el límite publicado. La reserva pertenece al intento durable y se vuelve a autorizar antes del modelo.
3. Liquidar cuota, crear el registro de consumo y guardar la salida cifrada del run ocurre en una sola transacción. Una escritura fallida no deja un consumo confirmado sin su checkpoint. El libro no recibe prompts ni texto de respuesta.
4. `ready` permite continuar sólo la entrega o sugerencia. El worker recupera trabajos interrumpidos que tienen ese checkpoint confirmado; el modelo no vuelve a ejecutarse. Los permisos y el vínculo se releen antes de usar el resultado. Una recuperación espera al turno activo de su conversación; si un mensaje posterior ya empezó a ejecutarse, se descarta la salida antigua. Los leases de preparación vencidos se liberan antes de reclamar trabajo, sin habilitar a su propietario anterior.
5. La respuesta automática usa la reclamación existente de `ConversationSendService`, anclada al inbound y efecto `reply`. Un acuse ya guardado se reutiliza. Un envío incierto no se repite. La salida temporal se elimina al terminar la entrega.
6. Si el modelo fue reclamado pero falta un resultado confirmado, el estado queda incierto. Un proceso nuevo no roba ese permiso ni vuelve a consultar al modelo. Una liquidación tardía confirmada puede habilitar la continuación en un tick posterior.

Los límites publicados gobiernan la llamada completa. El contenido de entrada y salida se limita a 4096 caracteres; sólo se admiten mensajes Meta `text`. Las comprobaciones de pausa, propietario humano, conversación cerrada/archivada, modo de empresa y vínculo se repiten antes de la salida. `normal` no ejecuta este agente; `mixed` produce sugerencia incluso si el vínculo permite auto; sólo `automator` más vínculo `auto` admite envío.

## Sugerencias y retención

En Asistido el trabajo termina con `AI_STRICT_SUGGESTION_READY` y no llama a Graph. La salida queda cifrada en el run durante el menor plazo entre una hora desde su creación y la ventana de 24 horas del inbound. Los ticks limpian físicamente resultados vencidos en lotes de 100 por empresa; una lectura también comprueba la caducidad. No hay texto en outbox, ledger ni logs nuevos.

`GET /api/v1/ai/whatsapp-suggestions?conversationId=<decimal positivo>` permite ADMIN y EMPLEADO, con el mismo alcance por tenant/conversación que la lectura actual de conversaciones. Devuelve `200 {suggestion: null | {runId, graphId, version, specHash, inboundMessageId, conversationId, reply, expiresAt}}`, con `Cache-Control: no-store`. El resultado exige outbox completado, checkpoint vigente y autorización actual. Un inbound posterior, pausa, toma de control humana, cierre, archivo, revocación del vínculo o desactivación de IA ocultan la sugerencia. Un ciphertext ilegible o cuya huella no coincide se borra y deja el run incierto; no genera un ciclo de recuperación.

Después del commit del trabajo, `agent:suggestion` se emite una sola vez en la sala de la conversación. Incluye sólo metadatos: `companyId`, `chatId`, `agentId: null`, `action: suggest`, `reason: strict_published_agent`, `conversationId`, `inboundMessageId`, `expiresAt` y `origin: {kind: published_graph, graphId, version, specHash, runId}`. El cliente relee el GET autorizado al recibirlo; el socket no transporta el texto ni publica la sugerencia en el dashboard. El identificador de grafo no se hace pasar por un agente numérico.

## Inspección y conciliación

Investigar en una transacción con `SET LOCAL app.current_tenant_id` y el rol de aplicación, usando el tenant verificado. Consultar metadatos, nunca descifrar salida o copiar credenciales a logs:

```sql
SELECT r.id, r.job_id, r.inbound_message_id, r.conversation_id,
       r.attempt_id, r.graph_id, r.graph_version, r.spec_hash, r.state,
       r.ledger_id, r.output_expires_at, w.status AS work_status, w.last_error
FROM strict_whatsapp_runs r
JOIN processing_outbox w ON w.tenant_id = r.tenant_id AND w.id = r.job_id
WHERE r.tenant_id = :tenant_id AND r.id = :run_id;

SELECT q.id, q.status, q.ledger_id, q.request_hash
FROM ai_quota_reservations q
WHERE q.tenant_id = :tenant_id AND q.id = :attempt_id;
```

Un intento reclamado sin acuse exige conciliación por proveedor y revisión operativa. No borrar reservas, no cambiar `attempt_id` y no poner arbitrariamente el outbox en pending. La ausencia de respuesta no demuestra que el modelo o Meta no hayan recibido la petición. La reconciliación automática de facturación del proveedor de modelo, los perfiles router/tools, la reanudación por ronda y el adaptador del ejecutor legacy al broker de efectos 061 quedan fuera de este corte.

## Reproducción local

Usar PostgreSQL local, una base dedicada terminada en `_smoke`, rol sin superusuario ni bypass RLS y migraciones hasta 062. Configurar `STRICT_AGENT_RUNTIME_TEST_DATABASE_URL` mediante el entorno privado, sin imprimirla. Las pruebas reemplazan credenciales por valores sintéticos y restringen sus proveedores a transporte local.

Desde `WhatsaapWeb-JS`:

```sh
npm run db:status
npm run typecheck
npm run build
node --import tsx --test src/test/strict-whatsapp-runtime-store-postgres.test.ts src/test/strict-whatsapp-binding-routes-postgres.test.ts src/test/strict-whatsapp-runtime-postgres.test.ts
npm test
```

La suite de almacenamiento cubre pin exacto/CAS, preparación concurrente, rollback de cuota y salida, aislamiento, TTL y sugerencias. La suite HTTP cubre autorización, validación, cambio explícito y conflicto administrativo. La integración ejecuta WhatsApp, el worker y PostgreSQL reales con transporte sintético para comprobar que el runtime strict no usa el router o proveedor anterior.

Validación del corte (2026-11-10): 28 pruebas PostgreSQL conjuntas, incluyendo `ai-quota-reservations-postgres.test.ts`; 22 pruebas existentes de `meta-inbound-work-postgres.test.ts` en otra base local; typecheck de producción y de los tres archivos nuevos de pruebas; build. La recuperación de un checkpoint anterior mientras un turno posterior tiene lease vigente, y la variante con lease de preparación vencido, primero fallaron con `23505 / uq_meta_inbound_active_conversation`; ambas pasan y verifican progreso sin respuesta antigua ni llamadas adicionales al proveedor.
