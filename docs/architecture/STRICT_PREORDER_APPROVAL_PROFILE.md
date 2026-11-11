# Plan del primer perfil con un efecto comercial

Este documento delimita el siguiente corte después de la identidad única de aprobaciones 068. El comportamiento descrito necesita implementación y evidencia antes de habilitarse. Parte de ADR-0011 y las secciones 7.3, 8.4 y 11.1 del blueprint v0.4.

## Recorrido propuesto

El cliente consulta el catálogo y solicita un prepedido. El agente prepara una intención durable con productos autorizados, cantidades y uno de los estados solicitables `draft`, `quoted` o `pending_handoff`. El estado por defecto es `draft`. El dominio crea o actualiza el prepedido editable de la conversación y devuelve su resultado.

El prepedido corresponde a `medium_write` en el blueprint y a `write` en el contrato actual del broker. Su ejecución automática exige empresa en modo `automator`, agente en modo `auto`, módulo `orders`, flag `orderUpsertPreorder`, autorización e idempotencia. La revisión humana se activa cuando la política aplicable, `requiresApproval` o un nodo `approval` explícito del grafo la exigen. En ese recorrido el supervisor decide en Aprobaciones y regresa al pedido y la conversación de origen.

El estado comercial `pending_approval` es un resultado del dominio que puede aparecer al detectar condiciones de revisión del producto, disponibilidad o backorder. El perfil debe conservar ese resultado, así como `unavailable`, en el prepedido y en la respuesta al cliente.

El perfil necesita identidad explícita en compilación, evaluación, publicación y vinculación. Una revisión publicada con perfil de texto o lectura conserva su alcance original. Se mantienen los contratos de invocación existentes del ToolBroker; la autorización del runtime añade la fuente canónica y la revisión publicada verificadas por el servidor.

## Propuesta durable

Antes de ejecutar el efecto o abrir una aprobación requerida, persistir una intención inmutable que incluya lo siguiente.

- Empresa, canal, conversación, mensaje entrante canónico y ejecución autorizada.
- Grafo, revisión, hash de especificación, nodo y acción lógica asignada por el servidor.
- Herramienta `order.upsertPreorder`, argumentos normalizados, estado permitido y hash de acción.
- Productos y alcance de catálogo verificados, cantidades, precios calculados por el servidor y versiones usadas para el resumen revisado.
- Política efectiva, grants, modo de empresa/agente y `ownership_epoch` de la conversación.
- Referencia al prepedido editable y su versión cuando la acción actualiza uno existente.
- Decisión de política, referencia a aprobación cuando se requiera, vencimiento y estado de continuación.

Cuando se requiere aprobación, su detalle muestra exactamente la intención que se va a ejecutar. La continuación recupera los argumentos persistidos y conserva el paso original. Una acción posterior legítima tiene su propia identidad y puede actualizar el mismo prepedido conforme al dominio.

## Frontera transaccional

La admisión evalúa la política efectiva del paso. Una aprobación requerida usa sesión firmada, membresía vigente, CAS, motivo y reautenticación según riesgo. La versión de la fila de aprobación y la versión de política se conservan como datos distintos.

Antes del efecto, bloquear y revalidar la intención, su autorización, la conversación, el modo de empresa/agente, la publicación fijada, los grants y las condiciones comerciales de los productos. Cuando se consume una aprobación, comprobar además su vigencia, la del supervisor y la correspondencia exacta con el paso. Un cambio que altere el contenido aprobado exige una propuesta nueva.

La creación o actualización del prepedido, el consumo de la autorización que corresponda y el recibo del efecto se confirman en la misma transacción PostgreSQL. La clave de idempotencia pertenece a empresa, ejecución, nodo y acción lógica. El recibo conserva el hash exacto y el ID de pedido. Una restricción de dominio evita repetir la mutación de ese paso.

Reutilizar el claim durable 061 y el repositorio de pedidos mediante el mismo cliente transaccional. El servicio de prepedidos necesita propagar la referencia canónica y la identidad del efecto al repositorio. El upsert conserva la selección del último prepedido editable, la fusión de líneas por producto y la continuidad de `pending_handoff`. El consumo queda referenciado por el paso ejecutado.

Después de un reinicio, la continuación consulta intención, autorización y recibo. Un commit confirmado permite recuperar el mismo pedido. Una transacción interrumpida permite retomar el paso con la misma clave y volver a comprobar permisos y estado del pedido. La implementación debe evitar transacciones hijas que esperen los bloqueos de la transacción exterior.

## Límites del corte

La creación del prepedido conserva las restricciones actuales del dominio. Confirmar ventas, reservar stock, validar cobros y devolver pagos mantienen sus controles propios. El envío al cliente continúa por el despacho canónico y su recibo independiente.

Los futuros efectos externos requieren el acuse y la conciliación específicos de su proveedor. Un estado incierto conserva su identidad hasta conocer el resultado. El primer corte utiliza un efecto local para comprobar propuesta, aprobación, dominio y receipt en una frontera transaccional verificable.

## Orden de implementación

1. Añadir la intención durable y su referencia al efecto, al prepedido y a la aprobación requerida, con RLS y compatibilidad con ejecuciones existentes.
2. Incorporar el compilador y la evidencia de evaluación del perfil explícito. Probar validación de argumentos, aislamiento y resultados de dominio antes de admitir la publicación.
3. Implementar la admisión automática y la continuación de los pasos que requieran aprobación, con consumo transaccional junto al upsert. Conservar la API de ToolBroker y los consumidores anteriores.
4. Componer el recorrido desde un mensaje canónico, la cola de Aprobaciones y el pedido hasta regresar a la conversación. Usar las rutas y los controles de navegación existentes.
5. Fijar un candidato y pasar la revisión independiente antes de activar el perfil.

## Criterios de aceptación

- Alfa y Bravo pueden compartir remitente e ID externo sin compartir propuestas, decisiones, pedidos o eventos.
- La misma acción solicitada desde dos procesos tiene una intención y una mutación confirmadas. Si requiere aprobación, ambos procesos comparten su solicitud. Una modificación de argumentos con la misma clave recibe conflicto.
- La admisión cubre ejecución automática permitida y aprobación requerida por nodo o política. Rechazo, vencimiento de una aprobación necesaria, falta de permiso, revocación, cambio de política y pausa o toma humana impiden despachar el paso.
- La contraseña se comprueba según la política existente y queda fuera de la propuesta, almacenamiento del cliente, auditoría e historial del runtime.
- SIGKILL antes de la decisión, después de aprobar y antes o después del commit recupera el estado sin duplicar el pedido.
- El resultado confirmado conserva el ID de pedido al reintentar. Una acción posterior autorizada puede actualizar ese pedido con su propia clave. Se conservan `draft`, `quoted`, `pending_handoff` y los resultados comerciales derivados del dominio.
- Web y móvil muestran pendiente, aprobada, rechazada, vencida y recuperación. El operador puede abrir el pedido resultante y volver a la conversación con su borrador y contexto.
- Las evaluaciones y simulaciones identifican sus efectos sintéticos. Las revisiones de texto y catálogo publicadas previamente conservan sus recorridos.
- Las pruebas de Chromium, PostgreSQL, cuota y autorización corren sobre el mismo SHA y registran omisiones y requisitos externos.

## Puntos de reutilización

- `WhatsaapWeb-JS/src/services/ai/broker/ToolBroker.ts`, `EffectCache.ts` y `HitlApprovalService.ts` ofrecen interceptación, claims y revisión humana.
- `WhatsaapWeb-JS/src/modules/ai/application/tools/PreorderToolService.ts` delimita los estados admitidos por IA.
- `WhatsaapWeb-JS/src/modules/orders/infra/db/OrderRepositoryPg.ts` crea el prepedido y necesita una identidad de efecto canónica para este recorrido.
- `WhatsaapWeb-JS/src/services/ai/runtime/StrictWhatsappRuntimeStore.ts` conserva la fuente, vinculación y autoridad de la conversación.
- `WhatsaapWeb-JS/src/test/tool-broker-effects-postgres.test.ts` aporta procesos concurrentes, reinicios y pérdida del acuse.
- `Frontend_py_whatsaapweb/e2e/approvals.integration.spec.ts` aporta revisión, reautenticación, recuperación, foco y uso móvil.
