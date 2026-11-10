# Caída entre recepción Meta y ejecución de la respuesta

La reproducción original sobre `ba9ed81`, conservada en `ec1be8b`, confirmó que un inbound persistido podía perder el trabajo de respuesta. Con la programación atómica posterior la misma prueba pasa: queda exactamente un job pendiente tras el commit, SIGKILL y redelivery. Este archivo conserva la evidencia previa; el contrato actual se describe en [Recuperación durable de inbound Meta](META_INBOUND_DURABLE_RECOVERY.md).

## Componentes y aislamiento

- Prueba: `WhatsaapWeb-JS/src/test/meta-inbound-crash.integration.test.ts`.
- Proceso HTTP hijo: `WhatsaapWeb-JS/src/test/fixtures/metaInboundCrashServer.ts`.
- Credenciales ficticias: `WhatsaapWeb-JS/src/test/fixtures/metaInboundCrashEnvironment.ts`.
- PostgreSQL propio: `meta_inbound_recovery_20261110_smoke`, con todas las migraciones del HEAD y rol sin superusuario ni bypass de RLS. La prueba exige host local y nombre `meta_inbound_recovery_*_smoke`.
- HTTP en `127.0.0.1:34380`; Graph simulado en `127.0.0.1:34381`. Ambos puertos son configurables; se rechaza el rango reservado 34262–34267.

El hijo construye `WhatsAppService` y usa la ruta firmada real, `MetaAccountStore`, `MetaInboxStore`, consultas de pausa/contexto, envío mediante `MetaCloudClient` y persistencia outbound. Solo sustituye el resultado del runtime IA por una respuesta determinista y el transporte HTTP de Graph por el servidor local. El transporte rechaza cualquier otro destino/ruta. No se llama a Meta ni a un proveedor de modelos; tampoco se heredan tokens reales en el proceso hijo.

## Sincronización exacta

1. Una subclase del store, exclusiva del fixture, espera a que termine `super.persistInboundMessage(input)`.
2. En ese punto la transacción real de `TenantScopedUoW` terminó con `COMMIT`; el store ya guardó mensaje y evento `processed`. El wrapper todavía no devuelve el resultado a `handleMetaWebhook`.
3. El hijo envía el evento IPC `inbound-committed` y queda suspendido en una promesa pendiente. No ejecuta `maybeAutoReplyWithAgent`.
4. El padre espera ese IPC y consulta PostgreSQL desde otro proceso/conexión. Comprueba un inbound visible, un webhook `processed`, cero inicios de runtime y cero envíos Graph.
5. Solo entonces envía **SIGKILL**, comprueba la señal de salida y el cierre de la solicitud HTTP pendiente.
6. Arranca un proceso HTTP nuevo, sin el corte, y repite el mismo webhook firmado. Consulta otra vez DB y registra el resultado.
7. Envía un inbound nuevo de control. Este sí produce una ejecución de runtime, un POST al Graph local y un outbound persistido, descartando un fallo general del transporte o del proceso reiniciado.

El punto de corte representa muerte del proceso, no una excepción capturada ni un cierre ordenado. No se basa en esperar un tiempo arbitrario para suponer que ocurrió el commit.

## Resultado observado antes de la corrección

| Evidencia | Resultado |
| --- | --- |
| Mensajes inbound confirmados para la solicitud cortada | 1 |
| Evento webhook al llegar al corte | `processed` |
| Filas en `processing_outbox` de la empresa al llegar al corte | 0 |
| Terminación del proceso | `SIGKILL` |
| Respuesta al repetir el webhook tras reiniciar | HTTP 200, `duplicate: true` |
| Filas en outbox tras repetirlo | 0 |
| Ejecuciones IA/respuestas para el inbound cortado | 0 / 0 |
| POST Graph del mensaje nuevo de control | 1, con outbound persistido |

En `ec1be8b`, la prueba termina con exit code 1 en `Committed inbound lost its response work before the process could schedule it`. El control sano pasa. No es evidencia de entrega real al celular.

Validaciones complementarias: `npm run typecheck` y `npm run build` pasan; los tres archivos nuevos de pruebas también pasan un chequeo TypeScript estricto directo, porque el `tsconfig` habitual excluye `src/test`. La suite existente `meta-webhook-p0.test.ts` pasa sus 11 pruebas. La reproducción se repitió después de reforzar la identidad del outbox y falló en la misma condición esperada, sin fallos de cleanup.

## Repetir sin mostrar credenciales

Preparar una base nueva con el nombre permitido y las migraciones del repositorio. Las dependencias se instalan siguiendo el entorno de desarrollo habitual; no hay paquetes nuevos. El archivo de entorno local usado en esta sesión contiene las variables de PostgreSQL y no se incluye en Git.

Desde `WhatsaapWeb-JS`, usando el archivo de entorno local autorizado:

```bash
set -a
source /tmp/product-browser-qa.OyVbm3CO/runtime.env
set +a
export DB_NAME=meta_inbound_recovery_20261110_smoke
export META_INBOUND_CRASH_TEST=1
export META_INBOUND_CRASH_HTTP_PORT=34380
export META_INBOUND_CRASH_GRAPH_PORT=34381
node --import tsx --test src/test/meta-inbound-crash.integration.test.ts
```

Las variables de PostgreSQL requeridas son `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` y `DB_PASSWORD`. No imprimirlas ni copiarlas a los reportes. Las variables Meta/JWT utilizadas por el fixture se reemplazan por valores ficticios. Sin `META_INBOUND_CRASH_TEST=1` la prueba se omite.

La ejecución elimina las filas de su propia empresa de fixture y termina los procesos/servidores que creó; conserva la base y su esquema para repetirla. No elimina datos de otras empresas ni bases.

## Uso con la corrección

La primera condición ya verificada es **persistencia del inbound y programación atómica**: una fila `whatsapp.inbound.received`, `pending`, con identidad/idempotency key y una referencia recuperable al inbound. Tras repetir el webhook se conserva la misma fila y sus referencias; el test compara también el UUID y la clave, no solo la cantidad.

Este test verifica la programación sin iniciar el worker. `meta-inbound-worker-crash.integration.test.ts` cubre ahora por separado el consumidor con procesos reales y un efecto HTTP local. La integración final con el sender autorizado debe conservar el mismo corte/IPC/SIGKILL y exigir un único POST/outbound. El control sano deberá esperar ese consumidor cuando el endpoint deje de ejecutar IA de forma síncrona.

Añadir por separado cortes después de reservar el envío y después de aceptación de Graph. Una respuesta externa incierta debe conciliarse sin repetir el POST; un trabajo pendiente no basta para demostrar esa propiedad. Tampoco se validan aquí herramientas con efectos laterales, el modelo IA, Socket.IO ni experiencia visual.
