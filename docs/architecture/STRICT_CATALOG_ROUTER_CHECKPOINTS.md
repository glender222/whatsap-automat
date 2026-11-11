# Recuperación durable del perfil de catálogo

Estado: verificación interna, 2026-11-11. `CatalogRouterCheckpointRuntime` ejecuta router, hasta una lectura existente de catálogo y respuesta final. Todos los resultados conservan `publicationEvidence: false` y `deliveryAllowed: false`. No hay montaje HTTP, worker, publicación, binding ni envío. `linear-text-v1` mantiene su contrato.

## Fallo reproducido

Con PostgreSQL y proveedor HTTP local, el probe anterior completaba una ronda y registraba su consumo. Al crear una instancia nueva con el mismo run devolvía `not_dispatched`: no repetía el cargo, pero había perdido el resultado necesario para continuar. La regresión roja comprobó primero catálogo y respuesta confirmada, y falló al exigir recuperación tras reinicio.

## Identidad y presupuesto

La migración 064 añade `catalog_router_runs`, `catalog_router_rounds` y `catalog_router_tool_checkpoints`, con FORCE RLS, claves compuestas por tenant y referencias a revisión exacta y ledger del mismo tenant. No cambia 063 ni las tablas del runtime de WhatsApp.

Un comando interno contiene tenant, UUID v4 de run, grafo, versión, specHash y entrada. La entrada tiene máximo 1024 caracteres y 1536 al serializarla; la segunda petición debe caber completa en los 4096 caracteres existentes, sin truncar. El run fija huella de entrada, revisión, autorización, máximos agregados y deadline absoluto. Reutilizar el mismo UUID con otros parámetros es conflicto antes de consumir una autorización nueva.

Sólo existen dos slots, `router` y `answer`, con UUID derivados de tenant/run/slot. Cambiar entrada o revisión no crea otro UUID. La segunda ronda requiere router confirmado. Cada slot usa las reservas reales de cuota compartida de la empresa; el run contabiliza ambos ledgers una sola vez en la transacción de liquidación. El máximo es la suma compilada de los dos presupuestos acotados. Las reservas se admiten por ronda: si ya no hay cuota para responder, se conserva el router y se informa el bloqueo; no se oculta su coste. La lectura conserva además el freno actual del broker de 4000 tokens previos.

El deadline nace en PostgreSQL y nunca se reinicia. Una reserva reclamada y sin resultado no se libera ni se vuelve a enviar. Mientras puede estar ejecutándose se informa `in_progress`; pasado el timeout, `uncertain`. Una respuesta incierta conocida en la llamada actual se informa inmediatamente como tal. El resultado confirmado se distingue por su checkpoint y ledger, no por el tiempo transcurrido.

## Puntos de confirmación

| Corte o fallo | Estado conservado | Recuperación |
| --- | --- | --- |
| Antes de reclamar el proveedor | Intento preparado | Puede intentar la misma reserva, dentro del deadline |
| Después de reclamar, sin acuse del proveedor | Reserva claimed sin checkpoint | Inspección/conciliación; ningún nuevo POST |
| Respuesta recibida, fallo antes de COMMIT de settle | Ni ledger ni checkpoint confirmados; reserva claimed | Estado incierto; ningún nuevo POST |
| COMMIT de settle confirmado, proceso cae | Ledger y salida cifrada de esa ronda | Releer salida autorizada, continuar siguiente slot |
| Lectura de catálogo, fallo antes de COMMIT | Sin snapshot confirmado | Repetir SELECT de sólo lectura dentro del plazo |
| Snapshot confirmado, acuse perdido | Snapshot único cifrado | Reutilizar el mismo snapshot después de revalidarlo |
| Respuesta final confirmada, proceso cae | Ambos ledgers y respuesta cifrada | Devolver el mismo resultado autorizado; cero llamadas nuevas |

La liquidación registra consumo incluso si el resultado llega tarde, excede límites o ya se revocó el permiso. Sólo guarda texto utilizable cuando el ledger confirma éxito, límites y deadline. Un fallo dentro del hook revierte liquidación y checkpoint juntos. No hay texto de cliente, catálogo ni respuesta en el ledger.

La lectura pasa por el `ToolBroker` actual y un adaptador registrado sólo para esta ejecución interna. El run se bloquea mientras se autoriza, lee y cifra el snapshot, en la misma transacción. Un segundo proceso encuentra ese snapshot; no repite una lectura ya confirmada. El INSERT comprueba el deadline del run y el timeout de 1000 ms de la herramienta, incluyendo esperas de conexión/lock: el timeout del broker no cancela el SQL subyacente y una lectura tardía debe revertir su snapshot. El snapshot guarda las huellas de entrada, salida y autorización y la proyección máxima de tres productos. La respuesta recibe sólo esa proyección, no IDs de permisos o metadata interna.

## Autorización y retención

Cada lectura de texto guardado revalida el permiso en su propia transacción antes de descifrar. Antes de cada POST se vuelve a comprobar. Se mantiene política strict, modo empresa/agente, flags explícitos, grant exacto del grafo y alcance fijado e intersectado con el vigente.

La huella incluye las versiones PostgreSQL `xmin` de política, grant, configuración de empresa y agente. Revocar y restaurar antes del replay cambia la versión y no revive la ejecución antigua. Es una invalidación conservadora: cualquier actualización de esas filas puede exigir un run nuevo. `xmin` se usa sólo para estos resultados efímeros, no como identidad de auditoría permanente ni como CAS público.

El snapshot también fija versiones y proyección de producto, pertenencia elegida, catálogo y sección. Se bloquean cambios de precio, producto retirado, catálogo/sección deshabilitados, pertenencia eliminada y revocar/restaurar. La comprobación relee como máximo tres productos bajo locks de lectura; no reemplaza su contenido por una búsqueda nueva. Incluso una respuesta final ya confirmada debe superar esta comprobación.

Texto y JSON se cifran mediante `SecretCipher`; cada payload tiene máximo 4096 caracteres. El run vence una hora después de crearse. Leerlo vencido borra los cifrados; `eraseExpired(tenant)` limpia hasta cien por llamada con `SKIP LOCKED`, conservando hashes y contabilidad. Este módulo no está montado: su futura composición **debe programar esa limpieza**. La migración por sí sola no garantiza eliminación física a la hora exacta sin un consumidor. Un payload corrupto bloquea; no genera otra llamada al proveedor.

No se mantiene una transacción abierta durante HTTP. La liquidación bloquea cuota antes de run; las lecturas de checkpoints bloquean run y filas de autorización, pero no bloquean cuota. La lectura local no abre otra transacción mientras mantiene bloqueado el run.

## Contrato pendiente para integrar Studio y WhatsApp

Los checkpoints son verificables, pero no equivalen a una evaluación aprobada. Antes de publicar o entregar se necesita:

1. Discriminador de perfil en evaluaciones/publicaciones/bindings, sin convertir permisos de texto existentes en permisos de herramientas. Fijar versión del adaptador, capability, grafo/specHash y suiteHash evaluados.
2. Evaluador propio que compruebe `expectedTools`/`forbiddenTools`, ambos ledgers, hashes de requests/resultados, coste agregado, ramas, revocación y tenant. La evidencia debe venir de estos eventos durables, nunca de una afirmación del modelo.
3. Adaptador de admisión que una el UUID a la fuente canónica única por tenant/inbound y al binding exacto. Debe fijar y revalidar `ownership_epoch` + `ia_paused_at` de 063, así como pausa/toma humana, nueva entrada y revocación del binding. Un UUID elegido libremente por una solicitud web no autoriza ejecución de WhatsApp.
4. Composición única con el emisor/sugerencia canónicos existentes: asistido conserva sugerencia, automático exige permisos/CAS vigentes, ventana de servicio y claim de entrega. Nunca usar este resultado interno directamente para enviar.
5. Limpieza periódica de payloads y procedimiento de inspección/conciliación de reservas inciertas. Esta fase no incorpora recuperación por proveedor ni autoriza reenvíos.

El perfil no admite tools mutativas, aprobación o delegación. Ampliarlo exige otro perfil y conservar autorización exacta, expiración, reautenticación, CAS, actionHash y claims de efectos 061. No se reutiliza un resultado cacheado para ampliar permisos.

## Verificación y operación

Usar PostgreSQL local `_smoke` con rol sin superusuario ni bypass RLS, migraciones hasta 064 y `STRICT_CATALOG_TEST_DATABASE_URL` suministrada desde entorno privado. No imprimir credenciales.

```sh
npm run db:migrate
npm run db:status
node --import tsx --test src/test/catalog-router-execution-profile.test.ts src/test/strict-catalog-router-postgres.test.ts src/test/strict-catalog-checkpoints-postgres.test.ts src/test/catalog-router-checkpoint-store-postgres.test.ts
npm run typecheck
npm run build
```

Para inspección, entrar en una transacción con el tenant autorizado y consultar metadata de `catalog_router_runs`, sus dos `catalog_router_rounds` y las reservas por `round_id`: estado, request_hash, ledger_id, consumo, claimed_at y deadlines. Confirmar coincidencia tenant/run/slot/revisión antes de interpretar un cargo. No descifrar texto para diagnosticar contabilidad. `claimed` sin ledger/checkpoint conserva la reserva y requiere evidencia externa para conciliación; no cambiarla a reserved ni crear otro run para forzar un reenvío.

Validación del corte: **38/38** pruebas de compilación, probe, checkpoints y store PostgreSQL; **251/251** regresiones de `npm test`; typecheck de producción y explícito de los cuatro archivos de prueba, build, migración 064 sobre esquema existente y `db:status` correctos. Las pruebas usan dos empresas, rol sin bypass RLS, proveedor HTTP loopback y credenciales sintéticas; prohíben transporte externo. Inyectan fallos deterministas antes/después de COMMIT y reinician instancias contra la misma base. No simulan un proveedor real ni afirman recuperación automática de un resultado desconocido.
