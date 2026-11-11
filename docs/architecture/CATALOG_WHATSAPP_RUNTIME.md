# Catálogo publicado en el flujo canónico de WhatsApp

El corte 067 conecta `catalog-router-v1` publicado en Studio con el inbound, el outbox, las sugerencias y el envío de `StrictWhatsappRuntime`. El perfil ejecuta `catalog.search` con una proyección acotada y el alcance vigente del agente aprobado. El binding explícito de WhatsApp habilita la ejecución de este perfil.

## Dependencias y contrato de binding

El flujo usa la autoridad de conversación de 063, los checkpoints de 064, las evaluaciones y publicaciones de 065–066 y la admisión de 067. El barrido de `App.start` retira el contenido cifrado de las sugerencias al vencer el TTL. [Retención de checkpoints](../qa/CATALOG_CHECKPOINT_RETENTION.md).

La ruta `/api/v1/ai/whatsapp-binding` ofrece GET, PUT y DELETE para administradores. PUT y DELETE comprueban `expectedRevision` mediante CAS. El cuerpo de PUT para catálogo tiene estos campos.

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

El perfil, la revisión y el hash del recibo deben coincidir con una publicación provider de la misma empresa. Las claves foráneas fijan la referencia en el binding y en el run. Cada edición genera otra revisión CAS. Cambiar la publicación activa requiere una nueva vinculación explícita para aplicar esa revisión a WhatsApp.

GET devuelve el vínculo persistido con `profile`, `evidenceVersion` y `evidenceHash` para catálogo. El administrador puede inspeccionarlo y borrarlo con CAS durante una pausa o después de perder acceso al proveedor. Al vincular, el servidor valida el manifiesto del recibo conservado, el plan aprobado y los permisos actuales.

El recibo publicado anuncia `whatsappBindingAllowed:true`; `GET /execution.profile` sólo lo anuncia cuando el compilador es compatible y el proveedor está disponible. Si el compilador rechaza un grafo marcado catálogo conserva `name:catalog-router-v1`, `compatible:false`, `issue:CATALOG_PROFILE` y `maxScenarios:0` (timeouts de formulario a 1 para conservar el contrato numérico); en pausa/credencial ausente también bloquea el vínculo. `executionAllowed` permanece falso. La interfaz debe mostrar también un binding histórico de la revisión consultada, aunque `execution.active` sea otra publicación global. Estas capacidades no sustituyen las comprobaciones al escribir ni la autorización de cada turno.

## Identidad, autoridad y contabilidad

`strict_whatsapp_runs` sigue teniendo un solo run por tenant/job/inbound. Fija entrada canónica, conversación, binding exacto, revisión, recibo publicado y los valores `ownership_epoch` e `ia_paused_at` de 063. El perfil usa ese mismo UUID como padre de `catalog_router_runs`. Una clave foránea compuesta exige coincidencia de tenant, UUID, grafo, revisión, specHash y perfil.

067 añade `operation` a checkpoints. Sus filas anteriores conservan `eval`, al igual que sus UUID y hashes de petición. Los checkpoints de WhatsApp exigen `completion` y un padre canónico; las dos rondas usan la cuota compartida existente. Reservas, ledgers y verificación exigen esa operación. La evidencia de Studio sigue exigiendo `eval`, de modo que una respuesta de producción no sirve para publicar una revisión.

Antes de cada lectura reutilizada, consulta de catálogo y llamada al modelo se comprueba la autoridad actual del outbox, la política strict, el binding exacto, el modo de empresa y la conversación. El snapshot se vuelve a contrastar con permisos y versiones actuales de productos, pertenencias, catálogos y secciones. Las huellas incluyen las versiones de las filas para descartar un run cuya autorización se retiró antes de concederse de nuevo. Una pausa/reanudación o toma de control cambia la autoridad canónica. Un nuevo inbound puede iniciar otro turno autorizado con datos actuales.

La liquidación de cada ronda confirma su ledger y checkpoint cifrado en una sola transacción. Después de confirmar router y respuesta, `recordCatalogCompletion` comprueba ambos ledgers y el snapshot antes de copiar la salida a `strict_whatsapp_runs.ready`. La copia conserva el ledger final como referencia y el vínculo al checkpoint conserva ambas rondas. Si el proceso cae entre ambos commits, la recuperación copia la respuesta de las rondas ya confirmadas y conserva sus cargos originales.

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

En modo asistido o con binding `suggest`, el resultado se ofrece al operador como sugerencia. El modo auto exige empresa automator, binding auto y autorización canónica antes del POST. La respuesta usa `sendAgentReply`, el claim y el recibo del outbox. Tras auto o resultado incierto, `finish` elimina el ciphertext del padre y de sus checkpoints, conservando identidades, hashes, consumos y recibos.

## Sugerencias y eventos

GET `/api/v1/ai/whatsapp-suggestions?conversationId=...` conserva `{suggestion:null|...}` y el acceso ADMIN/EMPLEADO del tenant. El objeto mantiene `runId`, `graphId`, `version`, `specHash`, `inboundMessageId`, `conversationId`, `reply` y `expiresAt`. Para catálogo también identifica el recibo.

```ts
{ profile: 'catalog-router-v1', evidenceVersion: 'catalog-publication-v1', evidenceHash: string }
```

Una lectura de sugerencia vuelve a verificar el snapshot real, además de binding, pausa/epoch, política, modo y vigencia. El evento `agent:suggestion` se emite en la sala de la empresa después de completar el outbox. Su `origin` conserva `{kind:'published_graph',graphId,version,specHash,runId}` y añade los tres campos de catálogo. El cliente recibe el texto mediante GET autorizado. La UI aplica la sugerencia al borrador y el operador decide el envío.

## Despliegue y rollback

Aplicar 067 antes de iniciar los procesos de API y workers que admiten catálogo. Verificar una base vacía y la actualización de una base 066. La evaluación, publicación y vinculación son pasos explícitos por empresa.

Antes de volver al código 066, pausar la política strict de las empresas afectadas y desvincular cada binding de catálogo mediante GET y DELETE con su `expectedRevision`. Detener y drenar los workers en curso. Revisar los intentos que quedaron claimed o con entrega incierta. Los recibos del proveedor determinan su conciliación. Conservar las tablas de 067, las reservas, los ledgers y los recibos para auditoría y recuperación.

## Interfaz y aislamiento del ensayo

Studio muestra el perfil y la revisión del catálogo vinculado. Bandeja identifica su sugerencia y relee el texto autorizado al recargar. La pausa y los cambios de autoridad invalidan el turno anterior. El administrador conserva lectura y desvinculación cuando pierde disponibilidad del proveedor.

Cada ejecución local de los modos verificación y proveedor usa su propia base `_smoke`. Una repetición paralela que compartía base permitió que el worker de verificación reclamara los mensajes del ensayo proveedor y dejó las rondas claimed. La prueba debe aislar también la base porque los workers recorren sus empresas. La fixture intercepta la URL de OpenAI en ambos modos y exige modo proveedor explícito antes de admitir esa llamada.

## Evidencia reproducible

La primera regresión publicó agentes de dos empresas mediante Studio real (ocho POST al proveedor local y recibos 066) y falló al vincular explícitamente: Ambas solicitudes devolvieron HTTP 422. La segunda detuvo el proceso después de las dos rondas y antes de ready. El worker dejaba el turno sin recuperar. Ambas regresiones forman parte de `catalog-whatsapp-runtime-postgres.test.ts` y su fixture `catalogWhatsappCrashWorker.ts`.

```sh
npm run db:migrate
npm run db:status
node --import tsx --test src/test/catalog-whatsapp-runtime-postgres.test.ts
node --import tsx --test src/test/strict-whatsapp-binding-routes-postgres.test.ts src/test/strict-whatsapp-runtime-store-postgres.test.ts src/test/strict-whatsapp-runtime-postgres.test.ts
npm run typecheck
npm run build
```

Proporcionar privadamente `CATALOG_WHATSAPP_TEST_DATABASE_URL` y `STRICT_AGENT_RUNTIME_TEST_DATABASE_URL` a una base local `_smoke` con rol sin superuser ni bypass RLS. Las pruebas usan HTTP loopback para el modelo y Graph. Publican, vinculan, reciben webhooks, reclaman el outbox, ejecutan el worker y persisten mensajes y recibos en PostgreSQL.

El chequeo general detectó y corrigió también una regresión de composición: importar el orquestador legacy inicializaba indirectamente el broker/BYOK de catálogo y exigía una clave de cifrado incluso sin ejecutar ese perfil. El perfil carga sus dependencias de catálogo al comenzar una ejecución explícita.

Validación: **134/134** pruebas conjuntas de perfiles, checkpoints, Studio y WhatsApp canónico; **18/18** en la suite nueva final (incluye la comprobación posterior de modo paused/legacy y desvinculación histórica con CAS); **251/251** de `npm test`. Typecheck/build de producción, tipos explícitos de pruebas y fixture de crash, migración incremental067 y `db:status` correctos. La revisión independiente confirmó la brecha de recuperación reproducida y reparada; no señaló otro bloqueo tras coordinar la dependencia del barrido TTL.


La composición de 067 con el barrido TTL y el filtro de suites pasó 152 pruebas de API/PostgreSQL, 252 pruebas generales de backend, typecheck y build. Los recorridos de Chromium verificaron 43 casos generales, tres de Studio con proveedor local y cuatro de Mercado Pago local. Las regresiones de contrato del frontend pasaron 23 casos. Las capturas de catálogo corresponden a un viewport de 390 px. Los ensayos con cuentas reales siguen registrados como pendientes en el plan del producto.
