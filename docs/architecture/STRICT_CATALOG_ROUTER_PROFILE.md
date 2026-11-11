# Perfil estricto de router y catálogo

Estado del corte: compilación, ejecución durable y [evaluaciones de Studio](CATALOG_STUDIO_EVALUATIONS.md), 2026-11-11. La evaluación usa el proveedor acotado y evidencia propia; la [publicación versionada de 066](CATALOG_STUDIO_PUBLICATIONS.md) verifica esa evidencia, mientras siguen bloqueados binding de WhatsApp y worker. La migración 064 y su contrato de recuperación se describen en [checkpoints del perfil](STRICT_CATALOG_ROUTER_CHECKPOINTS.md); la 065 discrimina los perfiles de evaluación. La 063 pertenece a la invalidación por versión canónica de conversación en el runtime de texto y no se modifica aquí.

## Problema reproducido

Con PostgreSQL, rol sin bypass RLS y dos empresas, la herramienta existente `CommercialCatalogToolService.search` devuelve el producto activo del catálogo autorizado de cada agente. Sin embargo, el grafo router → consulta → respuesta no es compatible con `linear-text-v1`. La prueba de producto primero falló en la expectativa de compatibilidad (`false !== true`), después de comprobar catálogo y aislamiento reales.

El perfil de texto está publicado y evaluado para una sola llamada. Añadirle un router o herramientas cambiaría el comportamiento aprobado sin nueva evidencia. El perfil nuevo tiene nombre, configuración, topología y límites propios; el compilador, dispatcher, evaluador, publicación y binding actuales de texto siguen rechazándolo.

## Especificación comprobable: `catalog-router-v1`

El perfil requiere exactamente cuatro nodos y estas cuatro aristas, sin prioridades ni condiciones adicionales:

| Origen | Destino | Condición |
| --- | --- | --- |
| router de entrada | tool | `catalog` |
| router de entrada | agent de respuesta | `reply` |
| tool | agent de respuesta | incondicional |
| agent de respuesta | end | incondicional |

El router tiene `{profile: "catalog-router-v1", provider, model, prompt, maxTokens, timeoutMs}`. El agente de respuesta tiene los mismos campos salvo `profile`. Ambos deben usar exactamente `boundedTextCapability`, prompt no vacío de hasta 3000 caracteres y timeout entre 1 y 30000 ms. El router permite hasta 256 tokens de salida; la respuesta, hasta 1024. El sistema añade al router un protocolo fijo que sólo acepta:

```json
{"route":"catalog","query":"consulta de hasta 200 caracteres","limit":3}
```

o `{"route":"reply"}`. JSON inválido, objetos encadenados, herramientas alternativas, IDs de empresa/catálogo y campos adicionales se rechazan. El modelo nunca proporciona el tenant, actor, grafo, alcance, riesgo, clave de efecto ni permiso.

El nodo tool tiene exactamente:

```json
{
  "toolName": "catalog.search",
  "schemaVersion": 1,
  "agentId": 123,
  "catalogScope": {"catalogIds": [10], "sectionIds": []},
  "maxResults": 3
}
```

Los IDs son enteros positivos seguros. Cada lista admite hasta 50 IDs distintos; al menos una debe ser no vacía. `maxResults` está entre 1 y 3. `end` tiene configuración vacía. Otros tools, riesgos, flags, delegaciones y bloques de aprobación son incompatibles con este perfil.

Los límites son: exactamente cuatro pasos, cero delegaciones, paralelismo uno y hasta 60 segundos. La duración declarada debe cubrir los dos timeouts de modelo más 1000 ms de lectura. Tokens y coste deben cubrir la suma de `boundedTextBudget` para ambas llamadas; no se estiman mediante longitud del texto. El broker conserva además su freno actual de 4000 tokens consumidos antes de invocar una herramienta. Ese freno adicional puede bloquear una llamada válida del modelo; el adaptador no lo elimina ni finge que la lectura ocurrió.

No hay bucle de reparación, segunda herramienta ni reintento automático del proveedor. Cambiar esa semántica exige otro perfil y evidencia.

## Primer bloque implementado

`CatalogRouterReadProbe` carga una revisión exacta guardada por tenant, ID, versión y huella. Compila el perfil, autoriza el catálogo, pide la decisión al proveedor acotado y ejecuta, si corresponde, **una** lectura real mediante `ToolBroker` y un `StrictCatalogSearchTool` registrado únicamente en ese probe. No se modifica el registro global de herramientas.

Sus resultados posibles incluyen `route_ready`, `tool_result_ready`, `blocked`, `uncertain` o `not_dispatched`; todos contienen `publicationEvidence: false` y `deliveryAllowed: false`. No ejecuta el nodo de respuesta, no entrega sugerencias ni mensajes, no escribe una evaluación aprobada y no puede publicar una revisión. Es un bloque de verificación con transporte inyectable, no una alternativa al runtime de producción.

La ronda de router usa la cuota real compartida de la empresa y el adaptador actual, con credencial cifrada y destino permitido. El identificador de ronda es un UUID derivado de `[namespace, tenantId, runId, slot]`; los slots son `router` y `answer`. No incorpora versión, entrada o huella: cambiar esos parámetros con el mismo run debe **conflictuar** con la reserva, en vez de obtener un permiso nuevo. El hash de petición sí incluye perfil, revisión, huella, límites, protocolo, entrada y presupuesto. Un replay exacto no repite el POST; sin checkpoint de salida, devuelve `not_dispatched`.

La lectura exige simultáneamente:

- Política strict activa y empresa en `mixed` o `automator`.
- Agente numérico del mismo tenant, activo y en `suggest` o `auto`.
- Flags JSON originales `moduleAccess.catalog === true` y `toolAccess.catalogSearch === true`. Los valores ausentes no autorizan.
- Grant explícito y habilitado para ese grafo y `catalog.search`, con rol `agent` permitido. Un grant global o el rol por defecto del broker no lo sustituye. Restricciones `limits_override` no vacías se rechazan hasta soportar su semántica.
- Intersección entre alcance fijado en el grafo y alcance vigente del agente. En cada dimensión, una lista vacía significa ausencia de esa restricción; si ambas restringen, se intersectan. Una intersección vacía de listas restringidas deniega. Al menos una dimensión debe permanecer restringida.

La autorización se relee después del modelo y dentro de la transacción de lectura. Se reutiliza `CommercialCatalogToolService.search` con `ProductRepositoryPg` y cliente del tenant. La consulta conserva producto/catálogo/sección activos y habilitados para IA. El resultado expone sólo ID, nombre, precio, modo de precio y moneda, hasta tres items y 2048 caracteres; no expone membresías en otros catálogos, instrucciones internas, descripciones ni URLs. Los bloqueos de permisos y las consultas tienen timeout; una finalización posterior al plazo no se devuelve como resultado listo.

El resultado de herramienta añade huellas de entrada, autorización y salida. El envelope del probe identifica tenant, run, revisión, perfil, ronda, ledger, consumo, nodo, invocación, riesgo y estado. Son observaciones internas en memoria, **no evidencia durable de publicación**. La cuenta del proveedor no recibe nombres de catálogo ocultos y ningún texto de producto se escribe en el ledger.

## Adaptación durable necesaria antes de producción

El probe y el runtime no deben exponerse como ejecución libre o entrega del worker. La migración 064 implementa rondas, consumo y snapshots de los puntos 3–6; la 065 incorpora el evaluador propio del punto 7 y el discriminador de evaluación. La publicación y composición canónica siguen pendientes con los controles siguientes:

1. **Pin y compatibilidad.** Añadir un discriminador de perfil a evidencia/publicación/binding. Los registros existentes conservan `linear-text-v1`. Una publicación nueva debe fijar perfil y versión de comportamiento, capability, versión de grafo, specHash, suiteHash y digest de adaptadores/esquemas de tool. Una evaluación de texto o simulación no satisface esa publicación. Publicar otra versión nunca mueve automáticamente el binding.
2. **Fuente durable.** Mantener la unicidad del run por tenant/inbound ya existente. Fijar el binding y la versión canónica de conversación incorporada por 063. Una pausa, toma humana, nueva revisión del vínculo o cambio de versión de conversación invalida salida y continuación; reanudar no revive el resultado antiguo.
3. **Rondas.** Persistir hijos del run identificados por `(tenant, run, ordinal/slot)`, con UUID estable, hash de petición, estado, reserva, ledger, timeout y deadline absoluto. Admitir sólo `router` y `answer` en ese orden. Un parámetro distinto con la misma identidad es conflicto. Una ronda reclamada sin acuse queda incierta y no se repite.
4. **Presupuesto agregado.** Registrar el máximo de ambas rondas y hasta una lectura. Admitir reservas de modelo bajo el mismo control de cuota compartido y bloqueo del run; no permitir llamadas fuera de esos slots ni reiniciar el presupuesto tras un crash. Los consumos inciertos mantienen su reserva. La evaluación y la telemetría suman router y respuesta, incluso cuando no hay salida entregable. Si se opta por reservas de ambos slots al inicio, deben ser atómicas y liberar sólo slots no reclamados al terminar; nunca liberar un intento de resultado incierto.
5. **Checkpoints cifrados.** Liquidar cada modelo y guardar su salida acotada en la misma transacción. Persistir la decisión parseada y el snapshot autorizado de la lectura antes de preparar la segunda ronda. La salida/catálogo se cifran con TTL acotado y limpieza física, sin texto en ledger ni logs. Un snapshot corrupto, vencido o de autorización revocada bloquea la continuación.
6. **Evidencia de tools.** Persistir por invocación tenant/run/ronda/nodo, nombre y versión del adaptador, hashes de input/output/autorización, estado real del broker, fuente y fecha del snapshot, IDs de recursos leídos y revisión del grant. La segunda petición vincula ese snapshot exacto. Releer catálogo en un replay no equivale a reusar la misma evidencia; el broker actual no cachea lecturas. La evidencia debe existir antes de marcar el paso como confirmado.
7. **Evaluación real.** Extender la suite con expectedTools/forbiddenTools sobre eventos persistidos del broker, no sobre texto del modelo o una simulación. Exigir escenarios de lectura autorizada, ruta sin consulta, revocación, tenant ajeno, scope reducido, dato no elegible, pérdida de acuse y continuación. La aprobación de publicación verifica las dos rondas, sumas de uso y trazabilidad al ledger bajo RLS.
8. **Salida canónica.** Sólo una respuesta final confirmada y aún autorizada podrá pasar a sugerencia o al emisor canónico. Conservar `mixed` sin envío, CAS/versionado, pausa/toma humana, ventana de servicio, cuenta/phone del tenant, claim de efecto `reply` y estado de entrega desconocida sin reenvío.

Los bloqueos de fuente/ejecución, cuota y checkpoints deben tener un orden definido; no abrir transacciones hijas mientras una transacción externa espera un run bloqueado. Ninguna transacción permanece abierta durante HTTP del modelo, Graph o una herramienta remota.

## Mutaciones y aprobación

Este perfil no admite mutaciones, aunque un modelo las solicite o un grant global exista. Una futura ampliación necesita otro perfil. Debe conservar flags y alcance actuales, modo empresa/agente, sandbox sin efectos, estado de conversación y autorización vigente antes de **leer un resultado cacheado** o despachar.

Los efectos deben usar el claim durable 061 vinculado a tenant/run/tool/actionHash y un ID asignado por el servidor. Cambiar parámetros no puede consumir un permiso anterior. Financiero/destructivo y `requiresApproval` conservan propuesta exacta, expiración, reautenticación del supervisor, versión de política y revocación. Una aprobación no autoriza otra acción ni elimina CAS. La continuación tras aprobar debe referenciar el paso original; no volver a pedir al modelo una acción supuestamente equivalente. Resultado desconocido exige conciliación del proveedor y nunca otro envío automático. El ledger actual de efectos no sustituye al almacén cifrado de snapshots de lectura.

## Hallazgos legacy separados

`AgentToolExecutor` interpreta flags ausentes mediante `!== false` y registra también herramientas write/send; no se reutiliza completo. `catalog.getItem` y `availability.check` tienen comprobaciones de alcance/estado distintas a `search`; no forman parte del perfil. `ProductRepositoryPg` agrega todas las membresías de un producto, por lo que la proyección explícita evita divulgar metadatos fuera del alcance. Corregir esos recorridos legacy requiere regresiones propias; este corte no altera su comportamiento.

## Pruebas y salida del corte

Usar una base PostgreSQL local terminada en `_smoke`, migrada hasta 062, y exportar `STRICT_CATALOG_TEST_DATABASE_URL` desde un entorno privado sin imprimirla. Ejecutar desde `WhatsaapWeb-JS`:

```sh
node --import tsx --test src/test/catalog-router-execution-profile.test.ts src/test/strict-catalog-router-postgres.test.ts
npm run typecheck
npm run build
```

Las pruebas usan dos empresas, catálogos/agentes reales y HTTP loopback con credenciales sintéticas distintas; el proveedor real y Graph están prohibidos. Verifican parseo, topología, límites agregados, identidad por ronda, cambio de entrada/revisión, ausencia de grant explícito, flags ausentes, revocación durante el modelo, scope ampliado/reducido, orden y efectos inexistentes, cuota compartida, pérdida de acuse y fallo/bloqueo de PostgreSQL. Los asserts conservan el rechazo del perfil en el dispatcher de texto de producción.

Validación del corte: 16/16 pruebas nuevas (7 del compilador y 9 del recorrido PostgreSQL), 251/251 de `npm test`, typecheck de producción y de ambos archivos de prueba, build y `git diff --check`. La comparación del resultado inicial rojo se conserva en el caso de producto como rechazo explícito del compilador/dispatcher de texto, junto a la aceptación independiente del perfil nuevo.
