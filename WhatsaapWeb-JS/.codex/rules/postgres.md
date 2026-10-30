# PostgreSQL Rules

Estas reglas aplican a PostgreSQL, `pg`, repositorios, stores y migraciones SQL.

## Migraciones

- Crear migraciones incrementales en `src/db/migrations`.
- No editar migraciones antiguas ya aplicadas salvo instruccion explicita del usuario.
- Nombrar migraciones con prefijo numerico secuencial y descripcion clara.
- Cada migracion debe ser idempotente cuando sea razonable: `IF NOT EXISTS`, constraints con nombres claros, indices seguros.
- Si una migracion cambia contratos usados por codigo, actualizar repositorios, mappers y docs.

## Acceso A Datos

- No hacer SQL directo desde rutas.
- Usar repositorios, stores o infraestructura dedicada.
- Usar parametros de query; nunca interpolar input del usuario en SQL.
- Convertir filas SQL a entidades o DTOs con mappers cuando haya transformacion no trivial.
- Mantener nombres de columnas y tablas consistentes con el dominio.

## Transacciones

- Usar transacciones cuando una operacion escriba varias tablas que deban quedar consistentes.
- Reusar `PgUnitOfWork` o patrones existentes antes de crear otra abstraccion.
- En errores, asegurar rollback y liberar conexiones.

## Performance

- Evitar consultas sin limite en endpoints de listas o historiales.
- Usar paginacion para conversaciones, mensajes, logs y registros crecientes.
- Agregar indices cuando una nueva consulta filtre, ordene o una tablas grandes por columnas especificas.
- Evitar N+1 queries; preferir joins controlados o consultas agrupadas.
- Seleccionar solo columnas necesarias cuando el payload pueda crecer.

## Integridad

- Preferir constraints, foreign keys y unique indexes para reglas estructurales.
- Definir defaults claros para estados operativos.
- Evitar borrar datos historicos sin una estrategia explicita.
- Para auditoria, preservar registros importantes de mensajes, conversaciones, agentes y acciones automaticas.

## Validacion

- Cambios de DB deben considerar `npm run db:status`.
- Si se agregan migraciones, considerar `npm run db:migrate`.
- Cambios TypeScript relacionados deben pasar `npm run typecheck`.

