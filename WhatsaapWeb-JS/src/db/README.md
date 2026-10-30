# src/db

Infraestructura de base de datos y migraciones versionadas.

## Ubicación
- `migrations/`: archivos SQL versionados additive-only.
- `Migrator.ts`: runner TypeScript para aplicar migraciones de forma ordenada y transaccional.

## Convivencia temporal
`src/core/coreModel.ts` continúa inicializando tablas legadas como bootstrap transicional.
Las nuevas migraciones en `src/db/migrations/` son aditivas y coexisten sin duplicar ni romper
el DDL existente.

No ejecutar migraciones automáticamente en startup; usar los scripts npm cuando se requiera.

## Scripts
- `npm run db:migrate` — aplica migraciones pendientes.
- `npm run db:status` — muestra estado de migraciones.
- `npm run db:migrate -- --dry-run` — simula ejecución sin tocar la base de datos.

Si PostgreSQL no está disponible, los scripts terminan graceful con código 0 y un warning.
