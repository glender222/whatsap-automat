# Retención periódica de checkpoints de catálogo

La corrección parte de `ef439cc` y completa la composición de evaluaciones 065. No cambia el TTL ni habilita publicación, binding, envío o proveedor alguno.

## Antes y después

Antes, una empresa sin nuevas llamadas de evaluación conservaba físicamente los cifrados vencidos hasta volver a usar un endpoint que llamara a `eraseExpired`. La prueba con `App.start` de `ef439cc` dejó dos empresas sin tráfico HTTP y falló al observar que sus runs seguían sin limpiar. Además, construir el almacén sin una clave de cifrado válida fallaba incluso para una operación que solamente elimina datos.

Después, iniciar App pone en marcha la limpieza y cerrar el servidor la detiene. El cifrador se crea únicamente cuando hace falta cifrar o descifrar. La limpieza usa el mismo método transaccional existente de 064; no necesita descifrar resultados ni solicitar credenciales del proveedor.

## Límites operativos

- Consulta únicamente IDs de `companies`, con cursor ascendente y máximo 100 por página. No filtra empresas por actividad o disponibilidad de Studio.
- Admite como máximo cuatro empresas concurrentes y un lote de hasta 100 runs vencidos por empresa. Un backlog completo no provoca un bucle exclusivo sobre esa empresa.
- Espera diez segundos después de completar cada página y vuelve al inicio tras la última. No solapa barridos dentro de la instancia. La consulta por empresa tiene `statement_timeout=1000ms`; filas ocupadas se omiten con `FOR UPDATE SKIP LOCKED` y se revisitan posteriormente.
- Usa `TenantScopedUoW`, RLS y el mismo pool de App. Los errores se aíslan por empresa; los logs sólo contienen identificador y código acotado, sin mensaje SQL, payload ni credenciales.
- Sólo elimina `output_encrypted` vencidos de rondas y snapshots; conserva hashes, filas, ledgers, reservas y contabilidad, y marca el run como `expired`.
- Un esquema sin tablas de 064 devuelve un aviso y se reintenta; no se realizan migraciones, llamadas externas o ejecuciones del modelo desde el worker.
- Al cerrar HTTP, se solicita la detención: cancela el timer y no admite empresas nuevas. `stop()` es idempotente y espera las consultas ya admitidas. Los bloqueos/transacciones de PostgreSQL mantienen la idempotencia entre instancias.

El TTL de una hora invalida el contenido independientemente de su eliminación física. No hay garantía de borrar exactamente al minuto 60: el desfase depende del número de páginas, el volumen vencido y la disponibilidad de PostgreSQL. Si todas las instancias están detenidas, la limpieza se retoma al arrancar.

## Prueba reproducible

Usar una base local dedicada terminada en `_smoke`, migrada hasta 065 y propiedad de un rol sin superusuario ni bypass RLS. Entregar privadamente la URL en `STRICT_CATALOG_TEST_DATABASE_URL`; nunca imprimirla. Para las regresiones existentes, `AI_QUOTA_RESERVATIONS_TEST_DATABASE_URL` y `AGENT_STUDIO_TEST_DATABASE_URL` pueden señalar la misma base aislada.

Desde `WhatsaapWeb-JS`:

```sh
npm run db:migrate
npm run db:status
node --import tsx --test src/test/catalog-checkpoint-retention.test.ts src/test/catalog-checkpoint-retention-postgres.test.ts src/test/catalog-router-checkpoint-store-postgres.test.ts src/test/strict-catalog-checkpoints-postgres.test.ts src/test/catalog-studio-evaluation-postgres.test.ts
npm run typecheck
npm run build
npm test
```

El caso PostgreSQL crea dos empresas, revisiones y rondas liquidadas mediante los stores reales. Envejece un run por empresa y conserva otro vigente; arranca App en un proceso con puerto efímero, sin petición HTTP y con red externa bloqueada. Observa SQL directamente para evitar que una lectura del store produzca la limpieza. Comprueba ambos cifrados de modelo y el snapshot, compara todos los hashes/consumos/ledgers/reservas antes y después, y confirma el cierre de App.

También ejecuta dos workers con una fila bloqueada, comprueba que la otra empresa progresa, libera el bloqueo y observa su limpieza posterior. Una cola de 101 runs comprueba el límite de 100 y la siguiente vuelta; la primera eliminación se realiza sin clave configurada. Un esquema parcial con dos empresas y sin tablas de catálogo verifica recuperación de `42P01` y apagado sin acceso a red. Las pruebas unitarias añaden 205 empresas, máximo de concurrencia, ausencia de ticks solapados, errores por empresa y cancelación del trabajo aún no admitido.

No se añaden variables de entorno, migraciones, dependencias, endpoints ni cambios a CI. El perfil de publicación conserva sus controles vigentes.

Validación local: **43/43 pruebas focalizadas**, incluidas las nuevas pruebas unitarias y PostgreSQL de retención; **252/252 regresiones de `npm test`**, sin skips. Typecheck de producción y de los tres archivos de pruebas/fixture, build, migración 065, `db:status` y diff check correctos. La prueba negativa con el arranque original falló sólo en la limpieza autónoma; después pasó con la misma composición y sin peticiones a Studio.
