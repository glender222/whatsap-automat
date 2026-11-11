# Publicación del perfil de catálogo

La migración 066 permite publicar `catalog-router-v1` mediante el flujo existente de Studio. Publicar confirma una revisión evaluada; **no habilita ejecución manual, binding, sugerencias ni envío de WhatsApp**. Esos caminos siguen rechazando catálogo hasta integrar la admisión canónica de conversación y su recorrido completo.

## Puerta de publicación

`POST /api/v1/agent-graphs/:id/publish?version=N` conserva `{evaluationId}` y los controles ADMIN, tenant y proveedor strict. La transacción bloquea el grafo y vuelve a comprobar:

1. Revisión exacta, specHash, suite del mismo tenant, modo provider y perfil de catálogo.
2. Evaluación `completed`, `passed`, sin regresión ni herramientas prohibidas, dentro de su deadline, con `execution_evidence_version='catalog-evaluation-v1'`.
3. Cada caso se reconstruye desde su UUID durable. Router y respuesta tienen dos ledgers distintos, reservas settled, capability/modelo/peticiones exactos y consumo dentro de los límites agregados. Se verifican hashes, salidas cifradas vigentes y cronología del snapshot de catálogo.
4. El grant, agente, modo de empresa, política strict y alcance siguen autorizados. La elegibilidad de productos, catálogos, secciones y pertenencias coincide con el snapshot. Revocar y restaurar un permiso o producto no revive evidencia anterior: las versiones de fila forman parte de las huellas.
5. Se recalculan las aserciones y métricas desde la evidencia y se comparan con el scorecard persistido. La tasa alcanza el mayor de 95% y el umbral de la suite. La cobertura incluye un caso aprobado que exige y ejecuta `catalog.search`, y otro aprobado que prohíbe expresamente `catalog.search` y responde sin herramientas. Mencionar el tool en texto no prueba su uso.

La validación usa los mismos contratos que el evaluador; no hace peticiones al proveedor ni ejecuta herramientas. Conserva el orden de locks hijo → autorización → evaluación. Las publicaciones son inmutables, con RLS forzado y avance monótono de versión por grafo/modo. La repetición exacta de POST devuelve el mismo recibo sólo si la evidencia y los permisos aún son válidos; no elude el gate.

Las evaluaciones anteriores a 066 conservan scorecards y perfil, con versión de evidencia nula. No se convierten retroactivamente en autorizaciones: requieren una evaluación nueva. Los recibos y DTO de texto existentes mantienen su formato.

## Recibo y contrato HTTP

El recibo de catálogo conserva `graphId`, `version`, `evaluationId`, `mode`, `specHash`, `suiteHash`, `publishedAt` y añade:

```ts
{
  profile: 'catalog-router-v1';
  evidenceVersion: 'catalog-publication-v1';
  evidenceHash: string;       // SHA-256 del manifiesto canónico
  authorizationHash: string; // revisión y permisos observados
  executionAllowed: false;
  whatsappBindingAllowed: false;
}
```

El manifiesto persistido contiene versiones de perfil, verificador, capability y adaptador, IDs de revisión/suite/evaluación, límites, UUID de rondas, referencias a ledgers, hashes de peticiones/resultados/aserciones/herramientas, consumos y latencias. Una proyección explícita excluye entradas, prompts, nombres/precios de productos, respuestas y ciphertext. El hash ordena claves de objetos para ser estable después de almacenar JSONB. El recibo permanece consultable cuando el TTL de los checkpoints ha vencido; no prolonga la retención del texto.

El campo `active` de `GET /execution` muestra la publicación más reciente del grafo en el modo de ejecución. Studio muestra su versión y perfil y comprueba ambos antes de ofrecer acciones. Un binding existente continúa fijado a su revisión exacta.

Los resultados de evaluación añaden `evidenceVersion: 'catalog-evaluation-v1' | null`, `publicationAllowed: boolean`, `publicationEvidence: boolean` y `publicationBlocker: string | null`. En evaluaciones aprobadas, observar vuelve a verificar el gate sin cambiar `status` o `passed` históricos. Esta disponibilidad es orientativa: POST vuelve a verificar todo al escribir.

| Bloqueo | Significado |
| --- | --- |
| `CATALOG_PUBLICATION_EVIDENCE` | Caso sin completar, prueba ausente/caducada/incoherente o evaluación no aprobada |
| `CATALOG_PUBLICATION_VERSION` | Evaluación anterior a la versión de evidencia admitida |
| `CATALOG_PUBLICATION_COVERAGE` | Falta cubrir consulta y respuesta sin catálogo con las aserciones requeridas |
| `CATALOG_PUBLICATION_AUTHORIZATION` | Los permisos o elegibilidad actuales impiden usar la prueba |
| `CATALOG_PUBLICATION_SUPERSEDED` | La evidencia coincide, pero otra publicación ocupa esa versión o una posterior |

Sin bloqueo, ambos booleanos son verdaderos. En `SUPERSEDED`, `publicationEvidence` sigue verdadero pero `publicationAllowed` es falso. Conceder de nuevo un permiso puede producir `EVIDENCE` si su huella ya cambió. Los conflictos POST mantienen ProblemDetails `code=CONFLICT` con el motivo en `detail`; la pausa mantiene la respuesta de proveedor no disponible existente.

`GET /execution.profile` conserva `publicationAllowed:false` porque no identifica una evaluación seleccionada. Añade `publicationSupported`, verdadero cuando el proveedor y los límites admiten al menos los dos casos requeridos, más `executionAllowed:false` y `whatsappBindingAllowed:false`. La compatibilidad de compilación por sí sola no constituye evidencia.

Si cambian los permisos entre consultar la evaluación y publicar, Studio usa el `409` para volver a leer la disponibilidad y el recibo activo. Bloquea la acción anterior, conserva el resultado histórico y enfoca la explicación del bloqueo. Con el permiso restablecido, una evaluación nueva puede reunir evidencia vigente. Chromium reproduce este recorrido con un cambio del modo de Alfa y verifica también la publicación y consulta independiente de Bravo.

El TTL de los checkpoints invalida el contenido al vencer y un barrido de `App.start` retira el texto cifrado en lotes por empresa. El manifiesto de publicación y la contabilidad se conservan. [Retención y pruebas](../qa/CATALOG_CHECKPOINT_RETENTION.md).

## Integración de WhatsApp pendiente

`dispatchPublishedAgent` rechaza catálogo antes del dispatcher; `StrictWhatsappRuntimeStore.loadPin` sólo admite publicaciones `linear-text-v1`. No se registra un runner alternativo ni un endpoint que devuelva texto de evaluación.

La siguiente integración debe seleccionar explícitamente perfil, versión, specHash y evidencia publicada con CAS, derivar una identidad estable desde tenant/inbound y usar la conversación canónica de 063 (`ownership_epoch`, `ia_paused_at`). Debe revalidar permisos/binding/política y pausa/toma de control antes de cada admisión y entrega, conservar los checkpoints y la cuota compartida, y entregar o sugerir por el outbox existente. Ningún permiso de mutación, aprobación o envío se hereda del perfil de sólo lectura. La huella de publicación es un recibo de revisión, no una autorización permanente sobre productos vivos.

## Evidencia reproducible

La primera regresión ejecutó suites reales de Alfa y Bravo con PostgreSQL y un proveedor HTTP local; ambas aprobaron con cuatro ledgers y 112 tokens, pero publicar devolvía 409. Ahora la misma prueba publica 200 con recibo estable y cero llamadas adicionales al proveedor. Las negativas usan revisiones inéditas para no confundir un rechazo por evidencia con una versión ya publicada.

```sh
npm run db:migrate
npm run db:status
node --import tsx --test src/test/catalog-studio-publication-postgres.test.ts src/test/catalog-studio-evaluation-postgres.test.ts src/test/bounded-agent-dispatch.test.ts src/test/agent-studio-postgres.test.ts src/test/publication-gate.test.ts
npm run typecheck
npm run build
```

Las URLs de prueba se proporcionan privadamente en `STRICT_CATALOG_TEST_DATABASE_URL`, `AI_QUOTA_RESERVATIONS_TEST_DATABASE_URL` y `AGENT_STUDIO_TEST_DATABASE_URL`, apuntando a PostgreSQL local `_smoke` con rol sin superuser ni bypass RLS. Se cubren aislamiento, EMPLEADO, suite ajena, revocación/restauración, pausa, snapshot/reserva/ledger/cronología dañados, cobertura insuficiente, evidencia sin versión, TTL, inmutabilidad y rechazo de ejecución/binding después de publicar. El conjunto ampliado también conserva las pruebas de SIGKILL/reanudación y cancelación de evaluación.

Validación del corte 066: **96/96** pruebas de perfiles, checkpoints, evaluación y publicación API/PG y compatibilidad; **251/251** de `npm test`; typecheck y build de producción, typecheck explícito de las pruebas, migración incremental y `db:status`. La suite nueva aporta doce casos incluyendo el contenedor; también verifica publicación concurrente, cambio texto v1 → catálogo v2 sin mover el binding previo, y rechazo de replay tras hacer incompatible el compilador sin ocultar el recibo histórico. No se usaron proveedores externos ni se modificaron UI, CI o la rama de integración.
