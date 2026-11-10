# Recuperación durable de inbound Meta

`MetaInboxStore` programa `whatsapp.inbound.received` en `processing_outbox` dentro de la misma transacción que guarda el mensaje y marca el webhook procesado. Si falla la programación, no se confirma ninguna de esas escrituras. El payload contiene referencias de empresa/mensaje/conversación/línea, no una segunda copia del texto ni credenciales.

La clave es `meta-inbound:` seguida de SHA-256 de JSON `[companyId, phoneNumberId, wamid]`. La redelivery conserva la fila y no cambia su estado ni sus referencias. Se mantiene la identidad histórica `message:${wamid}` del receipt, que participa en la autorización del envío; una colisión de wamid entre líneas de la misma empresa devuelve `META_INBOUND_PHONE_CONFLICT` en lugar de asociarla silenciosamente. Empresas distintas son independientes.

Los imports directos de historial sin `metadata.phone_number_id` siguen siendo solo historial: no tienen identidad de línea con la que autorizar una respuesta. La ruta firmada de Meta exige esa identidad antes de llamar al store. No se crean trabajos retroactivos para receipts históricos sin outbox: pudieron haber ejecutado efectos antes del despliegue.

## Estados y recuperación

| Estado outbox | Significado para este tipo de evento | Recuperación automática |
| --- | --- | --- |
| `pending` | Persistido, sin callback iniciado | Puede reclamarse cuando corresponde |
| `processing` | Claim con lease y token; solo rehidratación | Otro worker puede reclamarlo tras vencer el lease |
| `dispatched` | Se confirmó la reserva para entrar al runtime | Nunca vuelve a invocarse automáticamente |
| `completed` | Callback finalizó como `completed` o `skipped`; detalle en `payload.outcome` | Ninguna |
| `delivery_unknown` | Runtime pudo ejecutar efectos; faltó confirmación o devolvió incertidumbre | Ningún replay, aunque haya reinicios |
| `dead_letter` | Referencia inválida o preparación agotó reintentos antes del runtime | Ninguna automática |

La frontera conservadora está en el commit de `processing → dispatched`. Una caída inmediatamente después, incluso antes de entrar al callback, termina en `delivery_unknown`. No puede distinguirse con seguridad de una caída tras efectos; no se promete ejecución exacta una vez de sistemas externos.

Todas las transiciones comprueban empresa, job, tipo de evento, estado y token. Entrada y finalización normal exigen un lease vigente según el reloj de PostgreSQL. Una finalización tardía no sobrescribe el resultado incierto. Los errores de preparación pueden reintentarse con backoff limitado; cualquier excepción o resultado inválido después de entrar al runtime queda incierto. El relay genérico excluye este evento, incluyendo su estado `delivery_unknown`.

## Orden, concurrencia y autoridad

Un claim no salta un predecesor `pending`, `processing` o `dispatched` de la misma conversación. El índice único de migración 058 impide dos filas activas por empresa/conversación; otras conversaciones pueden ocupar las plazas libres del worker. `maxConcurrency` admite 1–32 y vale 4 por defecto. Los polls continúan mientras otras conversaciones ejecutan callbacks.

Un trabajo incierto no bloquea permanentemente nuevos inbound. La protección frente a otro envío con una claim sin conciliar corresponde al sender durable; este worker no reejecuta el trabajo incierto.

La rehidratación cruza empresa, mensaje, conversación, canal, proveedor, phone number y wamid. Además exige que `raw_payload_json.from`, `external_contact_id` y el destinatario de la conversación coincidan. Una referencia adulterada no llega al callback.

`execute(work, authority)` recibe:

```ts
type MetaInboundOutcome = {
  status: 'completed' | 'skipped' | 'uncertain';
  code?: string;
};

// work: jobId, companyId, messageId, conversationId, phoneNumberId,
// inboundProviderMessageId y message (payload original rehidratado).
// messageId y conversationId son strings para no perder precisión de PostgreSQL.
interface MetaInboundAuthority {
  isCurrent(client?: Queryable): Promise<boolean>;
  signal: AbortSignal;
}
```

Con `client`, `isCurrent` se ejecuta dentro de la transacción del caller y conserva un `FOR SHARE` sobre el job. Permite validar autoridad junto al claim de envío. Sin cliente abre una transacción propia. `signal` se aborta al vencer el runtime o pedir `stop()`.

La cancelación es cooperativa: un callback que ignore el signal puede seguir ejecutando código. El sender y las herramientas deben comprobar autoridad cerca de sus efectos y usar sus propias claves durables. El worker garantiza que un sucesor no vuelve a ejecutar el mismo trabajo después de cruzar la frontera, no puede retirar una petición HTTP ya enviada.

## Composición

El webhook confirma la recepción después de persistirla. `App` arranca `MetaInboundWorker` al escuchar conexiones y lo detiene al cerrar el servidor. El callback procesa el texto con el historial anterior al inbound de la misma conversación. Descarta respuestas del modelo que llegan después de vencer el turno. Los envíos automáticos pasan por una reserva que comprueba la autoridad del trabajo, la línea y el estado de la conversación. [Reserva y conciliación de envíos](../../WhatsaapWeb-JS/docs/qa/META_AGENT_SEND_CLAIMS.md).

`start()` inicia polling, `stop()` cancela y espera el trabajo local; `processBatch(companyId?)` permite un pase controlado en pruebas. La migración 058 añade un registro de discovery con IDs de empresa y políticas RLS, más índices de polling/orden/unicidad. No abre acceso global al contenido del outbox.

## Validación local reproducible

Usar una base PostgreSQL aislada `meta_inbound_recovery_*_smoke`, un rol sin superusuario/bypass RLS, todas las migraciones y las variables `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`. Los fixtures reemplazan las credenciales de proveedor por datos ficticios. No se usa Meta ni un modelo real.

```bash
META_INBOUND_CRASH_TEST=1 node --import tsx --test \
  src/test/meta-inbound-crash.integration.test.ts \
  src/test/meta-inbound-worker-crash.integration.test.ts \
  src/test/meta-inbound-work-postgres.test.ts
```

Los tests de procesos emplean IPC, observación desde otra conexión y SIGKILL, sin depender de un sleep para suponer el commit. El servidor de efectos local usa `127.0.0.1:34383`; la reproducción HTTP original usa 34380/34381. Para avanzar un lease tras matar el proceso solo se cambia el deadline de esa fila de fixture, nunca el reloj del servidor.

- Caída después del commit inbound: el reinicio recupera el trabajo pendiente. La repetición del webhook conserva el mismo UUID.
- El servidor Graph local recibe el POST de respuesta y el proceso muere antes del acuse. Otro reinicio conserva un solo envío. Un recibo firmado concilia la entrega y el inbound siguiente vuelve a procesarse.
- Caída con claim `processing`: un nuevo proceso recupera el trabajo y produce un efecto.
- Caída tras reservar `dispatched` antes del callback: cero efectos, estado incierto, ningún replay.
- Caída tras efecto HTTP aceptado: un efecto, estado incierto; dos reinicios posteriores no lo repiten.
- PostgreSQL verifica rollback, dedupe concurrente, aislamiento, fencing, orden entre conversaciones, referencias alteradas, resultados terminales, timeout y parada del worker.

Las filas propias de los fixtures se eliminan y los procesos se cierran. La base de prueba permanece disponible. Quedan por validar el proveedor de modelos de producción, el comportamiento de las demás herramientas con efectos y la entrega con dos líneas reales.

Las tres suites anteriores, junto con `conversation-send-postgres.test.ts`, pasaron 31 pruebas sin omisiones. Incluyen las barreras de apagado durante claim manual y durante la reserva de runtime. También pasaron el build, la comprobación de tipos del backend y las suites de producto con dos réplicas.
