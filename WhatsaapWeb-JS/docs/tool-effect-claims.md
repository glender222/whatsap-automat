# Broker de herramientas: efectos durables

El broker conserva los controles de esquema, autorización actual, presupuesto,
aprobación, CAS y egress antes de consultar o ejecutar un efecto. Para herramientas
mutativas, la migración `061_tool_effect_claims.sql` amplía el ledger existente
`tool_execution_effects`; no agrega otro runner ni altera el contrato de estados
`ToolExecutionResultV1`.

## Invariantes

- La clave única `(tenant_id, effect_key)` se reclama y confirma en PostgreSQL
  **antes** de invocar la herramienta. No se conserva una transacción abierta
  durante el efecto externo.
- La reclamación vincula herramienta, run y hash canónico de la acción. Cambiar
  los parámetros o el run con la misma clave produce `EFFECT_KEY_CONFLICT`.
- Una reclamación nunca se reasigna automáticamente, tampoco al vencer su plazo.
  Un timeout no cancela la operación externa y no demuestra que haya fallado.
- Solo el token original puede registrar el resultado. Una actualización tardía
  de incertidumbre no degrada un resultado ya confirmado.
- PostgreSQL es la autoridad; un error del ledger no permite ejecutar en memoria.
  Las herramientas de lectura siguen sin cache de efectos.

| Evidencia | Respuesta del broker | Reenvío |
| --- | --- | --- |
| Resultado confirmado y misma acción | `cached`, salida persistida | No |
| Reclamación pendiente dentro del plazo | `failed`, `EFFECT_IN_PROGRESS` | No |
| Timeout, fallo tras invocar, reclamación vencida o resultado no persistido | `failed`, `EFFECT_OUTCOME_UNKNOWN` | No |
| No se pudo confirmar la reclamación | `failed`, `EFFECT_STORE_UNAVAILABLE` | No se invocó en esa llamada |
| Otra acción o run ocupa la clave | `failed`, `EFFECT_KEY_CONFLICT` | No |
| Registro histórico sin hash verificable | `failed`, `EFFECT_LEGACY_UNBOUND` | No |

Los resultados anteriores a 061 no se eliminan ni se les atribuye un hash
inventado. Permanecen consultables en el ledger. El broker no puede demostrar
que una nueva petición corresponda a sus parámetros originales y exige inspección.
Un resultado perdido después de un COMMIT confirmado en PostgreSQL puede
recuperarse con la misma petición: devolverá `cached`, sin repetir la herramienta.

## Inspección y recuperación

1. Con el rol de aplicación y la empresa verificada, abrir una transacción con
   `SET LOCAL app.current_tenant_id` y consultar por empresa y `effect_key`.
   Inspeccionar primero `run_id`, `tool_name`, `status`, `action_hash`,
   `dispatch_deadline`, `completed_at` y `error_details->>'code'`. No volcar
   `output`, argumentos ni credenciales en logs o tickets.
2. Si `status = 'executed'`, repetir exactamente la petición original permite
   recuperar la salida mientras los controles de acceso sigan autorizándola.
3. Si `status = 'processing'`, su plazo es diagnóstico, no un lease recuperable.
   Tras vencer, una consulta mediante la misma petición registra
   `delivery_unknown`; no genera un segundo efecto.
4. Para `delivery_unknown` o `EFFECT_LEGACY_UNBOUND`, comprobar la evidencia del
   sistema que recibió el efecto. No borrar el registro, sustituir su hash,
   ampliar el plazo ni cambiar la clave para forzar un reenvío.

La conciliación automática debe implementarse por proveedor: buscar un recibo
o una operación usando una identidad estable, verificar empresa y acción, y
registrar el resultado con evidencia auditada. Una herramienta arbitraria no
ofrece necesariamente cancelación, idempotencia remota o consulta del resultado.
Este cambio impide reenvíos automáticos del broker; no promete ejecución
exactamente una vez ni resuelve efectos inciertos sin esa evidencia. Tampoco
reutiliza `OperationExecutionService`: ese servicio solo proyecta ejecuciones de
workflows y su outbox, no reclama herramientas.

## Despliegue

Detener o drenar todas las instancias que ejecutan herramientas mutativas,
aplicar 061 y arrancar todas con el nuevo broker. No mezclar versiones: el
broker anterior no respeta reclamaciones y puede sobrescribirlas con su UPSERT.
La migración es aditiva y conserva los registros y políticas RLS existentes.

## Prueba reproducible local

`src/test/tool-broker-effects-postgres.test.ts` exige una conexión
`TOOL_BROKER_TEST_DATABASE_URL` a `127.0.0.1`, base terminada en `_smoke`, migrada
hasta 061, con rol sin superusuario ni `BYPASSRLS`. No llama a proveedores: usa
procesos Node separados y recibos de texto en un directorio temporal.

```bash
node --import tsx --test src/test/tool-broker-effects-postgres.test.ts
```

El caso concurrente y el caso `SIGKILL` tras el efecto fallan en `31c1e20`:
ambos dejan dos recibos para una sola clave. La corrección conserva un recibo.
La validación local final ejecutó 10/10 casos PostgreSQL sin omitir y 101/101
pruebas unitarias/adversariales relacionadas; también pasaron build, typecheck y
la comprobación estricta de los nuevos archivos de prueba.
La suite cubre también conflicto de parámetros, empresa ajena, permiso revocado,
timeout con efecto tardío, fallo de PostgreSQL y pérdida del acuse antes/después
de persistir el resultado. El double en `fixtures/brokerTools.ts` se limita a las
pruebas unitarias de los controles; la evidencia de concurrencia procede de
PostgreSQL y los procesos reales.
