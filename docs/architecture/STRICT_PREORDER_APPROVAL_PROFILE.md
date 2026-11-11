# Plan del primer perfil con un efecto comercial

Este documento delimita el siguiente corte después de la identidad única de aprobaciones 068. El comportamiento descrito necesita implementación y evidencia antes de habilitarse. Parte de ADR-0011 y las secciones 7.3, 8.4 y 11.1 del blueprint v0.4.

## Recorrido propuesto

El cliente consulta el catálogo y solicita un prepedido. El agente prepara una propuesta con productos autorizados, cantidades y estado `draft` o `pending_handoff`. El supervisor revisa la propuesta en Aprobaciones, decide y vuelve al pedido y la conversación de origen. El primer efecto consiste en crear ese prepedido mediante el dominio de pedidos.

El perfil necesita identidad explícita en compilación, evaluación, publicación y vinculación. Una revisión publicada con perfil de texto o lectura conserva su alcance original. Se mantienen los contratos de invocación existentes del ToolBroker; la autorización del runtime añade la fuente canónica y la revisión publicada verificadas por el servidor.

## Propuesta durable

Antes de abrir la solicitud de aprobación, persistir una propuesta inmutable que incluya lo siguiente.

- Empresa, canal, conversación, mensaje entrante canónico y ejecución autorizada.
- Grafo, revisión, hash de especificación, nodo y acción lógica asignada por el servidor.
- Herramienta `order.upsertPreorder`, argumentos normalizados, estado permitido y hash de acción.
- Productos y alcance de catálogo verificados, cantidades, precios calculados por el servidor y versiones usadas para el resumen revisado.
- Política efectiva, grants, modo de empresa/agente y `ownership_epoch` de la conversación.
- Referencia a la solicitud de aprobación, vencimiento y estado de continuación.

La aprobación muestra exactamente esa propuesta. La continuación recupera sus argumentos persistidos y conserva el paso original. La generación de otra acción por el modelo requiere otra propuesta y otra autorización.

## Frontera transaccional

La decisión usa la sesión firmada, membresía vigente, CAS, motivo y reautenticación según el riesgo y la política existentes. La versión de la fila de aprobación y la versión de política se conservan como datos distintos.

Al consumir una aprobación, bloquear y revalidar la propuesta, su autorización y la conversación. Revalidar la vigencia del supervisor, estado de pausa/propiedad, publicación fijada, grants, alcance y condiciones comerciales de los productos. Un cambio que altere el contenido aprobado exige una propuesta nueva.

El prepedido, el consumo de la autorización y el recibo del efecto se confirman en la misma transacción PostgreSQL. La clave de idempotencia pertenece a empresa, ejecución, nodo y acción lógica. El receipt conserva el hash exacto y el ID de pedido. Una restricción de dominio evita crear otro prepedido para ese paso.

Reutilizar el claim durable 061 y el repositorio de pedidos mediante el mismo cliente transaccional. El consumo queda referenciado de forma durable sin cambiar el significado de los estados públicos de aprobación. El servicio legacy de prepedidos necesita propagar la referencia canónica y la identidad del efecto al repositorio antes de servir como adaptador del perfil.

Después de un reinicio, la continuación consulta propuesta, consumo y recibo. Un commit confirmado permite recuperar el mismo pedido. Una transacción interrumpida permite retomar el paso con la misma clave y volver a comprobar permisos. La implementación debe evitar transacciones hijas que esperen los bloqueos de la transacción exterior.

## Límites del corte

La creación del prepedido conserva las restricciones actuales del dominio. Confirmar ventas, reservar stock, validar cobros y devolver pagos mantienen sus controles propios. El envío al cliente continúa por el despacho canónico y su recibo independiente.

Los futuros efectos externos requieren el acuse y la conciliación específicos de su proveedor. Un estado incierto conserva su identidad hasta conocer el resultado. El primer corte utiliza un efecto local para comprobar propuesta, aprobación, dominio y receipt en una frontera transaccional verificable.

## Orden de implementación

1. Añadir la representación durable de la propuesta y su referencia a aprobación y efecto, con RLS y compatibilidad con ejecuciones existentes.
2. Incorporar el compilador y la evidencia de evaluación del perfil explícito. Probar validación de argumentos, aislamiento y resultados de dominio antes de admitir la publicación.
3. Implementar la continuación y el consumo transaccional junto al prepedido. Conservar la API de ToolBroker y los consumidores anteriores.
4. Componer el recorrido desde un mensaje canónico, la cola de Aprobaciones y el pedido hasta regresar a la conversación. Usar las rutas y los controles de navegación existentes.
5. Fijar un candidato y pasar la revisión independiente antes de activar el perfil.

## Criterios de aceptación

- Alfa y Bravo pueden compartir remitente e ID externo sin compartir propuestas, decisiones, pedidos o eventos.
- La misma acción solicitada desde dos procesos tiene una sola propuesta, aprobación y pedido. Una modificación de argumentos recibe conflicto.
- Rechazo, vencimiento, falta de permiso, revocación del supervisor, cambio de política y pausa o toma humana dejan el efecto sin ejecutar.
- La contraseña se comprueba según la política existente y queda fuera de la propuesta, almacenamiento del cliente, auditoría e historial del runtime.
- SIGKILL antes de la decisión, después de aprobar y antes o después del commit recupera el estado sin duplicar el pedido.
- El resultado confirmado conserva el ID de pedido al reintentar. Ningún reintento vuelve a consumir la aprobación o admite un paso nuevo.
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
