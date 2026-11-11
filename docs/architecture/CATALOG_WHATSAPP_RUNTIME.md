# Catálogo publicado en el flujo canónico de WhatsApp

El corte 067 conecta `catalog-router-v1` publicado en Studio con el mismo inbound, outbox, conversación, sugerencia y envío de `StrictWhatsappRuntime`. No cambia un binding de texto, no habilita `/execute` manual ni registra herramientas de escritura. Sólo ejecuta `catalog.search`, con la proyección acotada y el alcance intersectado del agente aprobado.

## Dependencias y contrato de binding

Requiere 063 (autoridad de conversación), 064 (checkpoints), 065–066 (evaluación/publicación) y 067. La operación también requiere el barrido independiente de checkpoints conectado a `App.start`; las sugerencias conservan payloads temporales hasta el TTL. El barrido es un corte separado y debe integrarse antes de activar este perfil. Este cambio no duplica su worker.

La ruta existente `/api/v1/ai/whatsapp-binding` conserva GET/PUT/DELETE, ADMIN y CAS mediante `expectedRevision`. Para catálogo, PUT exige explícitamente:

```ts
{
  graphId: string;
  version: number;
  specHash: string;
  mode: 'suggest' | 'auto';
  expectedRevision: string | null;
  profile: 'catalog-router-v1';
  evidenceVersion: 'catalog-publication-v1';
  evidenceHash: string;
}
```

El cuerpo histórico sin esos tres campos sigue seleccionando sólo texto. No se infieren permisos por encontrar un grafo de catálogo. El perfil, revisión y hash del recibo deben coincidir exactamente con una publicación provider del mismo tenant; una clave o pin de otra empresa se rechaza. La referencia se conserva mediante FK en binding y run. Una publicación posterior no mueve el binding. Cada edición genera otra revisión CAS, aunque vuelva a seleccionar los mismos valores.

GET devuelve el pin persistido aun si cambian las capacidades del servidor o deja de estar autorizado, para que el administrador pueda inspeccionarlo y borrarlo con CAS. En catálogo añade `profile`, `evidenceVersion` y `evidenceHash`; el DTO de texto conserva su forma anterior. DELETE sigue disponible durante una pausa. El recibo de catálogo no caduca cuando se borra el texto de evaluación: para vincular se validan la integridad/versiones del manifiesto, el plan aprobado y sus permisos actuales, sin prolongar su retención.

El recibo publicado anuncia `whatsappBindingAllowed:true`; `GET /execution.profile` sólo lo anuncia cuando el compilador es compatible y el proveedor está disponible. Si el compilador rechaza un grafo marcado catálogo conserva `name:catalog-router-v1`, `compatible:false`, `issue:CATALOG_PROFILE` y `maxScenarios:0` (timeouts de formulario a 1 para conservar el contrato numérico); en pausa/credencial ausente también bloquea el vínculo. `executionAllowed` permanece falso. La interfaz debe mostrar también un binding histórico de la revisión consultada, aunque `execution.active` sea otra publicación global. Estas capacidades no sustituyen las comprobaciones al escribir ni la autorización de cada turno.

## Identidad, autoridad y contabilidad

`strict_whatsapp_runs` sigue teniendo un solo run por tenant/job/inbound. Fija entrada canónica, conversación, binding exacto, revisión, recibo publicado y los valores `ownership_epoch` e `ia_paused_at` de 063. El perfil nuevo usa ese mismo UUID como padre de `catalog_router_runs`; una FK compuesta exige mismo tenant, UUID, grafo, revisión, specHash y perfil. No hay un segundo identificador de turno elegido por el modelo.

067 añade `operation` a checkpoints. Sus filas anteriores conservan `eval`, al igual que sus UUID y hashes de petición. Los checkpoints de WhatsApp exigen `completion` y un padre canónico; las dos rondas usan la cuota compartida existente. Reservas, ledgers y verificación exigen esa operación. La evidencia de Studio sigue exigiendo `eval`, de modo que una respuesta de producción no sirve para publicar una revisión.

Antes de cada lectura reutilizada, consulta de catálogo y llamada al modelo se comprueba la autoridad actual del outbox, la política strict, el binding exacto, el modo de empresa y la conversación. El snapshot se vuelve a contrastar con permisos y versiones actuales de productos, pertenencias, catálogos y secciones. La retirada y posterior restauración de un permiso no revive el mismo run; sus huellas incluyen las versiones de las filas. Una pausa/reanudación o toma de control cambia la autoridad canónica. Un nuevo inbound puede iniciar otro turno autorizado con datos actuales.

La liquidación de cada ronda confirma su ledger y checkpoint cifrado en una sola transacción. Después de confirmar router y respuesta, `recordCatalogCompletion` comprueba ambos ledgers y el snapshot antes de copiar la salida a `strict_whatsapp_runs.ready`. La copia conserva el ledger final como referencia y el vínculo al checkpoint conserva ambas rondas. Si el proceso cae entre ambos commits, la recuperación usa las rondas confirmadas; no vuelve a cobrar ni pedir la respuesta.

La copia final no renueva el TTL ni el plazo de dispatch. La salida strict vence en el menor de una hora desde la preparación y la ventana ya existente del inbound. La llamada HTTP de un modelo ya admitido puede terminar después de una revocación y liquidar su consumo real, pero la revalidación impide utilizar ese resultado o seguir con otra ronda.

## Recuperación y entrega

`MetaInboundWorkRepository.recoverExpired` admite continuar un parent catálogo `prepared` únicamente si existe su checkpoint completion exacto, el router está confirmado y no hay rondas con resultado desconocido. Las rondas completadas necesitan ciphertext, reserva settled, ledger success y requestHash concordantes. Una ronda `claimed`, una liquidación sin checkpoint o una ronda terminal impiden la reanudación automática. Continuar una ronda pendiente exige deadline vigente; copiar una respuesta ya confirmada sólo exige que su salida siga vigente.

| Interrupción | Comportamiento |
| --- | --- |
| Router confirmado, antes de leer/responder | Reutiliza router y continúa dentro del deadline |
| Snapshot confirmado, antes de responder | Reutiliza snapshot tras revalidarlo |
| Ambas rondas confirmadas, antes de ready | Copia la salida confirmada; cero llamadas nuevas |
| Ready confirmado, antes de entrega | Reutiliza salida y vuelve a comprobar la autoridad |
| Modelo claimed sin acuse | `delivery_unknown`; no se reclama otra petición |
| Graph recibe POST pero se pierde el acuse | Claim/resultado incierto visible; no hay otro POST |

En modo asistido o binding `suggest`, el resultado se conserva como sugerencia; no se envía. El modo auto exige empresa automator, binding auto y autorización canónica antes del POST. La respuesta usa `sendAgentReply` y el sender/claim/outbox/recibo existentes; no añade una ruta de envío del runtime. Tras auto o resultado incierto, `finish` elimina el ciphertext del padre y de sus checkpoints, conservando identidades, hashes, consumos y recibos.

## Sugerencias y eventos

GET `/api/v1/ai/whatsapp-suggestions?conversationId=...` conserva `{suggestion:null|...}` y el acceso ADMIN/EMPLEADO del tenant. El objeto mantiene `runId`, `graphId`, `version`, `specHash`, `inboundMessageId`, `conversationId`, `reply` y `expiresAt`; catálogo añade:

```ts
{ profile: 'catalog-router-v1', evidenceVersion: 'catalog-publication-v1', evidenceHash: string }
```

Una lectura de sugerencia vuelve a verificar el snapshot real, además de binding, pausa/epoch, política, modo y vigencia. Nunca devuelve contenido de otro tenant. El evento `agent:suggestion` se emite una vez en la sala de conversación después de completar el outbox; su `origin` conserva `{kind:'published_graph',graphId,version,specHash,runId}` y añade los mismos tres campos de catálogo. No lleva `reply`: el cliente relee GET autorizado. La UI aplica la sugerencia al borrador y el operador decide el envío.

## Evidencia reproducible

La primera regresión publicó agentes de dos empresas mediante Studio real (ocho POST al proveedor local y recibos 066) y falló al vincular explícitamente: 422 para ambas en lugar de 200. La segunda mató el proceso después de las dos rondas y antes de ready: el worker no recuperaba nada. Ambas regresiones forman parte de `catalog-whatsapp-runtime-postgres.test.ts` y su fixture `catalogWhatsappCrashWorker.ts`.

```sh
npm run db:migrate
npm run db:status
node --import tsx --test src/test/catalog-whatsapp-runtime-postgres.test.ts
node --import tsx --test src/test/strict-whatsapp-binding-routes-postgres.test.ts src/test/strict-whatsapp-runtime-store-postgres.test.ts src/test/strict-whatsapp-runtime-postgres.test.ts
npm run typecheck
npm run build
```

Proporcionar privadamente `CATALOG_WHATSAPP_TEST_DATABASE_URL` y `STRICT_AGENT_RUNTIME_TEST_DATABASE_URL` a una base local `_smoke` con rol sin superuser ni bypass RLS. Las pruebas redirigen sólo el transporte conocido de modelo/Graph a HTTP loopback; publican, vinculan, reciben webhooks, reclaman outbox, ejecutan el worker y persisten mensajes/recibos reales. No sustituyen el sender ni las comprobaciones de autorización. No usan cuentas o proveedores reales.

El chequeo general detectó y corrigió también una regresión de composición: importar el orquestador legacy inicializaba indirectamente el broker/BYOK de catálogo y exigía una clave de cifrado incluso sin ejecutar ese perfil. Las dependencias de catálogo se cargan ahora sólo dentro de su rama explícita; no se relajan requisitos de cifrado para ejecuciones reales.

Validación: **134/134** pruebas conjuntas de perfiles, checkpoints, Studio y WhatsApp canónico; **18/18** en la suite nueva final (incluye la comprobación posterior de modo paused/legacy y desvinculación histórica con CAS); **251/251** de `npm test`. Typecheck/build de producción, tipos explícitos de pruebas y fixture de crash, migración incremental067 y `db:status` correctos. La revisión independiente confirmó la brecha de recuperación reproducida y reparada; no señaló otro bloqueo tras coordinar la dependencia del barrido TTL.
