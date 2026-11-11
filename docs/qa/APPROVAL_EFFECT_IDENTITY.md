# Una aprobación por efecto

## Defecto reproducido

Dos procesos de ToolBroker podían consultar la ausencia de una aprobación y crear dos solicitudes para la misma empresa y `effectKey`. Cada operador recibía un ID distinto. Una decisión registrada sobre una solicitud podía quedar desplazada por la búsqueda de la solicitud más reciente.

La reproducción usa dos procesos Node.js, PostgreSQL con RLS forzada y un rol sin superusuario ni `BYPASSRLS`. Una barrera de la fixture detiene ambos INSERT después de sus lecturas iniciales. El caso falla en `16e4635` porque recibe dos IDs.

## Corrección y compatibilidad

La migración 068 incorpora `historical_effect_key_conflict` y marca todos los integrantes de cada grupo histórico duplicado. Conserva sus IDs, propuestas, estados, decisiones y fechas. Un índice único parcial protege las claves nuevas y las históricas unívocas.

El alta consulta y reserva en una transacción. `INSERT ON CONFLICT DO NOTHING` espera al ganador concurrente y la lectura posterior devuelve su identidad. ToolBroker comprueba run, hash de propuesta, herramienta y riesgo antes de usar el resultado. Una propuesta distinta recibe `APPROVAL_ACTION_MISMATCH`.

Un grupo histórico ambiguo produce `APPROVAL_EFFECT_CONFLICT`. El contrato de lectura añade opcionalmente `executionBlocker` con ese valor. Web y móvil muestran la revisión pendiente y deshabilitan aprobar. Revisar y rechazar siguen disponibles con permisos, motivo, reautenticación sensible y CAS existentes. Las decisiones aprobadas y rechazadas anteriores conservan su estado. Una respuesta idempotente ya registrada sigue siendo consultable.

El bloqueo se comprueba también al decidir en el servicio reviewer y en el UPDATE atómico común, por lo que un cliente anterior recibe conflicto. El ledger durable 061 conserva su función de evitar una segunda ejecución física. Leer una aprobación histórica ambigua o una decisión idempotente anterior conserva el bloqueo del efecto.

## Recuperación de la interfaz

Una aprobación local cuyo acuse se perdió puede descubrir el conflicto histórico al volver a consultar. La interfaz descarta ese intento de aprobación pendiente y permite revisar o rechazar la solicitud. Mantener un botón de reintento deshabilitado habría ocultado también el rechazo.

La segunda pasada completa reprodujo una pérdida intermitente de foco en el caso existente de vencimiento con consulta fallida. Al cerrar el diálogo, el foco pedido por el efecto de React podía quedar inactivo. El foco al encabezado se programa en un frame cancelable después del desmontaje. Se conserva la aserción original y el caso pasó cinco repeticiones consecutivas.

## Migración y despliegue

1. Detener las réplicas anteriores que consumen aprobaciones antes de aplicar 068. Esas versiones todavía pueden seleccionar una solicitud histórica arbitraria.
2. Aplicar la migración con el propietario de las tablas y el migrador habitual. El migrador abre una transacción por archivo. El bloqueo DDL mantiene fuera las escrituras concurrentes durante el backfill. La migración retira temporalmente FORCE para que el propietario pueda marcar todos los grupos y la restablece antes del commit. Las políticas y el RLS habilitado permanecen presentes.
3. Arrancar las réplicas compatibles y comprobar la cola de cada empresa. La migración puede repetirse sin alterar decisiones ni propuestas.
4. Revisar cada grupo marcado usando la empresa, `effectKey`, ejecución y hash de acción originales. Contrastar el ledger con el resultado de negocio o el acuse del proveedor y registrar la conclusión en la auditoría operativa.
5. Rechazar las solicitudes pendientes duplicadas cuando corresponda cerrar su revisión. Conservar los registros decididos. Cualquier nueva propuesta requiere verificar primero qué parte de la acción queda realmente pendiente y obtener su autorización correspondiente.
6. Mantener bloqueado un resultado incierto hasta conciliarlo. El broker genérico aún requiere una implementación de conciliación específica de la herramienta o del dominio.

Para revertir la aplicación, detener primero las herramientas mutantes afectadas y conservar la migración y los recibos. El rollback a un consumidor anterior exige resolver la selección ambigua o mantener esos consumidores detenidos. Quitar el indicador histórico elimina información de la revisión.

## Evidencia

La suite existente `WhatsaapWeb-JS/src/test/tool-broker-effects-postgres.test.ts` añade cuatro casos y conserva las diez regresiones de claims anteriores.

- Upgrade desde la forma anterior de la tabla, duplicados aprobados/rechazados y pendiente de Alfa, misma clave en Bravo, dos aplicaciones de 068, comparación exacta de registros, índice único y RLS forzada al terminar.
- Dos brokers concurrentes reciben una sola identidad. La contraseña incorrecta conserva el pendiente, la correcta registra una decisión idempotente y el efecto se ejecuta una vez.
- Propuestas distintas con la misma clave producen una única solicitud y rechazo de la otra propuesta.
- Los históricos ambiguos conservan sus decisiones, impiden aprobar en ambos servicios de decisión, permiten rechazar y mantienen bloqueado el efecto.

`Frontend_py_whatsaapweb/e2e/approvals.integration.spec.ts` verifica diez recorridos contra App y PostgreSQL, incluido el histórico en móvil estrecho, recarga, descripción accesible del botón deshabilitado, rechazo y aislamiento. Los errores de las rutas canónica y legacy se comprueban mediante HTTP real.

Ejecutar con una base local terminada en `_smoke`, migrada hasta 068, y exportar `TOOL_BROKER_TEST_DATABASE_URL` desde un entorno privado.

```sh
# Desde WhatsaapWeb-JS
node --import tsx --test src/test/tool-broker-effects-postgres.test.ts
npm run typecheck
npm run build

# Con el harness de App/PostgreSQL y transporte sintético de CI activo
npm --prefix ../Frontend_py_whatsaapweb run test:e2e -- e2e/approvals.integration.spec.ts
npm --prefix ../Frontend_py_whatsaapweb run test:approvals
npm --prefix ../Frontend_py_whatsaapweb run build
npm --prefix ../apps/mobile run typecheck
npm --prefix ../apps/mobile test
npm --prefix ../packages/contracts test
```

Las fixtures usan credenciales sintéticas y transporte local. Este corte conserva cerrado el perfil canónico de herramientas con efectos mientras se implementan su propuesta durable, autorización de publicación y continuación después de una aprobación.

## Resultado local

La comprobación final pasó 14/14 casos PostgreSQL, 10/10 recorridos Chromium y 5/5 repeticiones del vencimiento. Pasaron 107/107 pruebas de broker, rutas y OpenAPI, 252/252 pruebas del backend, 205/205 de contratos, 5/5 de la API web y 42/42 del cliente móvil. Typecheck, build de backend y web, TypeScript estricto de las fixtures y ESLint de los archivos web modificados terminaron correctamente.

La captura revisada corresponde a la web a 390 px en tema oscuro. La pantalla Expo conserva verificación de tipos y pruebas del cliente. La comprobación en un dispositivo nativo queda pendiente para la validación móvil del candidato.
