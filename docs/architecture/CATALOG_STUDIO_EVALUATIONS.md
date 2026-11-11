# Evaluaciones de catálogo en Studio

Estado del corte: 2026-11-11. `catalog-router-v1` participa en el flujo normal de evaluaciones de Studio con proveedor real acotado. **Pasar una suite todavía no permite publicar, vincular con WhatsApp, ejecutar manualmente una publicación ni enviar mensajes.** La API devuelve scorecards y referencias de evidencia; no devuelve texto generado o contenido del catálogo.

## Discriminador y compatibilidad

La migración 065 añade `execution_profile` a `agent_eval_suites` y `agent_eval_runs`, con valores `linear-text-v1` y `catalog-router-v1`. Las filas anteriores reciben `linear-text-v1`. Su hash de suite y sus respuestas HTTP conservan el formato anterior. El hash de catálogo incluye explícitamente `{profile,suite}`.

Crear una suite de catálogo exige `profile: "catalog-router-v1"` y una revisión compatible. No se deduce el permiso de herramientas a partir del contenido de una suite vieja. Evaluar selecciona el perfil guardado en la suite; observar y cancelar seleccionan el guardado en el run, junto con tenant, grafo, revisión y modo. Una publicación de texto no cambia al publicar o guardar otro perfil.

La composición de catálogo utiliza la misma política strict, credencial BYOK y cuota que el resto de ejecuciones provider. El adaptador sintético de `createStudioVerification` no obtiene este perfil. Se conservan JWT, ADMIN y aislamiento de tenant de las rutas de Studio. Una empresa pausada puede observar/cancelar; no iniciar otra llamada al proveedor.

## HTTP

Todas las rutas existentes parten de `/api/v1/agent-graphs/:id` y requieren `?version=N`.

| Operación | Contrato de catálogo |
| --- | --- |
| `GET /execution` | Conserva `mode`, `availability`, `suites`, `active`; añade capacidades de catálogo en `profile` |
| `POST /evaluation-suites` | `{id: UUIDv4, name, profile: "catalog-router-v1", scenarios}` |
| `POST /evaluations` | `{suiteId, runId: UUIDv4, timeoutMs}`; repetir exactamente retoma un run aún en curso |
| `GET /evaluations/:runId` | Observación de scorecard y estado; no ejecuta proveedor |
| `POST /evaluations/:runId/cancel` | Cuerpo vacío; corta pasos futuros y conserva contabilidad del paso ya despachado |
| `POST /publish` y `/execute` | El catálogo sigue rechazado con conflicto; no hay publicación compatible habilitada |

El objeto `profile` de catálogo contiene `name`, `compatible`, `issue`, `model`, `publicationAllowed: false`, `minScenarioTimeoutMs`, `maxScenarioTimeoutMs`, `maxSuiteDurationMs`, `maxScenarios`, `maxInputLength: 1024` y `maxSerializedInputLength: 1536`. El mínimo de timeout es la suma de los dos modelos más los 1000 ms de catálogo; el máximo es el menor de 30000 ms y la duración total del grafo. `maxScenarios` es el techo a timeout mínimo según tokens, coste, duración y máximo absoluto de veinte. Si se aumenta el timeout, `scenarioCount * timeoutMs` también debe caber en `maxSuiteDurationMs`.

Las suites de catálogo listadas y creadas devuelven `{id,name,scenarioCount,profile}`; las lineales conservan `{id,name,scenarioCount}`. Los escenarios admiten `id`, `name`, `mockInput`, `expectedTools`, `forbiddenTools`, `expectedTextPatterns`, `forbiddenTextPatterns` y `assertions`. No admiten estado ficticio de conversación. Cada caso requiere al menos un patrón esperado de texto y una comprobación de herramienta, con máximo dieciséis aserciones combinadas. Exigir y prohibir el mismo tool es inválido. El perfil sólo ejecuta `catalog.search`; puede comprobar la ausencia de otros tools mediante `forbiddenTools`.

Las aserciones explícitas reutilizan los tipos existentes: texto, herramienta esperada/prohibida, máximo de pasos, coste y latencia. `approval_triggered` no está soportado. La ruta con catálogo tiene cuatro pasos y la ruta directa tres. Los campos tool nombrados en la respuesta del modelo no son evidencia de ejecución.

El resultado añade `profile: "catalog-router-v1"`, `publicationEvidence: false`, `publicationAllowed: false`, `totalTokensUsed`, `totalCostMicroUsd` y conserva `runId`, `suiteId`, `graphId`, `version`, `specHash`, `suiteHash`, `mode`, `status`, `passed`, `admittedScenarioId`, `scenarios`.

Cada escenario tiene `scenarioId`, `runtimeRunId`, `outcome`, `ledgerIds`, `tokens` y `costMicroUsd`. Cuando existe evidencia completa incluye:

- `executedTools: string[]`: vacío o `['catalog.search']` en este perfil.
- `failedAssertions: string[]`: IDs explícitos o prefijos `expected-tool-N`, `forbidden-tool-N`, `expected-text-N`, `forbidden-text-N`.
- `latencyMs` y `rounds: Array<{slot: 'router'|'answer', roundId, requestHash, outputHash, ledgerId}>`.
- `tool`, si hubo lectura: nombre, schemaVersion, nodeId, invocationId y hashes de entrada/salida/autorización.

`outcome` es `passed`, `assertion_failed`, `blocked` o `uncertain`. El estado global es `running`, `completed`, `failed` o `cancelled`. Una invalidación al cerrar la suite puede añadir `failureCode: "CATALOG_EVIDENCE_INCOMPLETE"`. No hay `output`, `reply` ni texto final en el DTO.

## Evidencia y recuperación

Cada escenario deriva un UUID v4 estable de tenant/evaluationId/scenarioId, separado de los UUID de las rondas. Su entrada, revisión y autorización quedan fijadas en 064. La fila de evaluación conserva el caso admitido y su deadline: reiniciar no renueva los límites. Se admiten como máximo las dos rondas ya compiladas por caso, bajo la misma cuota compartida.

`CatalogEvaluationEvidence` comprueba directamente PostgreSQL antes de aceptar un resultado:

1. Tenant, perfil, revisión, specHash, entrada y límites del run coinciden.
2. Router y respuesta tienen checkpoints completos, dos ledgers distintos de evaluación exitosa y reservas settled del proveedor/modelo exactos.
3. Los UUID y hashes de ambas peticiones se reconstruyen con el mismo plan del runtime. Consumos de checkpoints, ledger y run coinciden; no basta una respuesta `completed` en memoria.
4. El router confirmado determina si debe existir un snapshot de catálogo. Se comprueban cifrado/hash, input exacto, autorización y cronología router → snapshot → respuesta.
5. Se revalidan permisos y las versiones de producto, pertenencia, catálogo y sección antes de evaluar el texto. Al finalizar se vuelven a comprobar **todos** los casos, por si se retiró un producto después de aprobar un caso anterior.

El cierre no reutiliza texto del modelo para decidir `expectedTools` o `forbiddenTools`; usa el snapshot que confirmó el adaptador de lectura del broker. Una herramienta prohibida realmente ejecutada queda en `security_tool_leaks`, hace fallar su aserción y bloquea `passed`.

Dos POST simultáneos comparten el caso admitido, sus reservas y checkpoints. Una petición puede observar `running` (202) mientras la otra termina. Después de SIGKILL entre router/lectura/respuesta, repetir el mismo POST reanuda desde el resultado confirmado. Un proveedor reclamado sin acuse permanece incierto; la evaluación falla y no vuelve a despacharlo.

La cancelación se revalida entre pasos y antes del proveedor. Una llamada ya admitida puede liquidar su consumo, pero no habilita catálogo, otra ronda o un aprobado posterior. El scorecard cancelado se actualiza cuando llega ese consumo. La API no crea un canal alternativo de respuestas del worker.

GET de una evaluación terminada es **historia**: no vuelve a cobrar, no descifra texto y no convierte una aprobación histórica en autorización vigente. Los resultados cifrados siguen sujetos al TTL de 064; las operaciones de evaluación ejecutan limpieza acotada por tenant. El barrido periódico independiente continúa pendiente de la composición operativa del runtime.

## Publicación y próximos controles

`AgentStudioPublications` rechaza expresamente un grafo compatible con catálogo y exige `execution_profile='linear-text-v1'` para su puerta actual. El binding de WhatsApp conserva el preflight de texto. No existe un endpoint para devolver directamente la respuesta del nuevo runtime.

Para habilitar catálogo fuera de evaluación aún hacen falta el contrato de publicación propio (perfil y versión de adaptadores/evidencia), binding explícito que no mueva revisiones antiguas, fuente única tenant/inbound, controles canónicos `ownership_epoch`/`ia_paused_at` de 063, limpieza periódica y entrega/sugerencia bajo el flujo existente. Una evaluación pasada no omite esos controles.

## Pruebas

La regresión HTTP inicial devolvía 422 al crear una suite de catálogo válida; el flujo ahora la admite y verifica ejecución real con proveedor HTTP local. Las pruebas PostgreSQL usan rol sin bypass RLS, dos empresas y credenciales sintéticas distintas; no consultan proveedores externos.

```sh
npm run db:migrate
npm run db:status
node --import tsx --test src/test/catalog-studio-evaluation-postgres.test.ts src/test/bounded-agent-dispatch.test.ts src/test/agent-studio-postgres.test.ts src/test/publication-gate.test.ts
npm run typecheck
npm run build
```

Proporcionar privadamente las URLs locales `_smoke` mediante `STRICT_CATALOG_TEST_DATABASE_URL`, `AI_QUOTA_RESERVATIONS_TEST_DATABASE_URL` y `AGENT_STUDIO_TEST_DATABASE_URL`, sin imprimirlas. La suite mata procesos con SIGKILL después de checkpoints reales, retoma por la API y comprueba una llamada por ronda. También cubre cancelación, revocación, concurrencia, presupuestos, texto que menciona tools inexistentes, snapshot ausente, petición de ledger adulterada, cronología inválida y publicación denegada aun con suite pasada.

Validación: **84/84** pruebas de perfiles, checkpoints, evaluación API y compatibilidad de Studio/publicación; **251/251** de `npm test`; typecheck y build de producción, typecheck explícito de pruebas/fixture de crash, migración 065 sobre esquema existente y `db:status` correctos. No se utilizaron proveedores reales ni se modificó CI.
