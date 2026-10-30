# Architecture Rules

Estas reglas gobiernan cambios estructurales en el backend `WhatsaapWeb-JS`.

## Principios

- Mantener el backend como una aplicacion Node.js + Express + Socket.IO + TypeScript.
- Preferir TypeScript para codigo nuevo.
- No introducir frameworks grandes, ORMs o capas nuevas sin una razon concreta y aprobacion del usuario.
- Respetar la separacion entre entrada HTTP, logica de aplicacion, dominio, infraestructura y servicios externos.
- Mantener compatibilidad con rutas legacy solo cuando sea necesario para no romper el frontend actual.

## Capas Del Proyecto

Usar estas responsabilidades:

- `src/app.ts`: composicion de la aplicacion, middleware, rutas, Socket.IO, Swagger, arranque y manejo global.
- `src/routes`: definicion de endpoints, middlewares por ruta y adaptacion HTTP minima.
- `src/controllers`: controladores legacy o adaptadores delgados. No meter reglas de negocio complejas aqui.
- `src/services`: integraciones y casos de uso operativos, como WhatsApp, Meta Cloud API, IA y seguridad.
- `src/core/domain`: entidades y reglas del dominio operativo.
- `src/core/application`: casos de uso, puertos, DTOs y helpers de aplicacion.
- `src/core/infrastructure`: repositorios, mappers, adaptadores y detalles tecnicos.
- `src/modules`: modulos funcionales nuevos o aislables, con su propia organizacion interna.
- `src/db/migrations`: cambios incrementales de base de datos.
- `src/shared`: contratos y utilidades compartidas transversales.

## Flujo De Dependencias

- Las rutas pueden depender de services, modulos o casos de uso.
- Los services pueden depender de puertos, repositorios e integraciones externas.
- El dominio no debe depender de Express, Socket.IO, PostgreSQL, Meta, archivos ni variables de entorno.
- La infraestructura puede depender de `pg`, SQL, mappers y APIs externas.
- Evitar dependencias circulares entre `core`, `modules` y `services`.

## Rutas Y Contratos

- Mantener rutas modernas bajo `/api`.
- Usar nombres consistentes con recursos: `company`, `agents`, `tags`, `whatsapp`, `chats`, `media`, `webhooks`.
- Las rutas deben validar entradas antes de llamar servicios.
- Las respuestas deben tener estructura estable y no romper al frontend sin revisar `C:\whatsap\Frontend_py_whatsaapweb`.
- Si se cambia un contrato usado por frontend, actualizar o documentar el impacto.

## WhatsApp Providers

- Mantener separada la logica de `meta-cloud` y `whatsapp-web.js`.
- No mezclar reglas especificas de Meta Cloud API dentro de adaptadores legacy de WhatsApp Web.
- Usar `WHATSAPP_PROVIDER` para seleccionar comportamiento cuando aplique.
- Preservar el camino legacy si todavia existe compatibilidad con el frontend o flujos antiguos.

## Persistencia

- La persistencia debe vivir en repositorios, stores o infraestructura, no directamente en rutas.
- Usar mappers para convertir filas SQL a entidades/DTOs cuando el modelo no sea trivial.
- Si una operacion modifica multiples tablas, considerar transaccion o Unit of Work.
- No editar migraciones ya aplicadas salvo instruccion explicita.

## Socket.IO

- Socket.IO debe ser un mecanismo de transporte/eventos, no la fuente principal de reglas de negocio.
- Los eventos deben emitirse desde servicios o adaptadores con payloads estables.
- Mantener rooms y nombres de eventos compatibles con el frontend.

## IA Y Agentes

- Mantener reglas de agentes, knowledge, horarios, confianza y handoff en el modulo/servicio de IA.
- No permitir que la IA escriba acciones irreversibles sin pasar por reglas explicitas del negocio.
- Diferenciar sugerencias IA de mensajes enviados o acciones ya ejecutadas.

## Cambios Grandes

Antes de cambios estructurales amplios:

1. Leer `README.md`, `package.json`, `src/app.ts` y documentacion relevante en `docs/`.
2. Identificar rutas, services y repositorios afectados.
3. Mantener el cambio lo mas local posible.
4. Actualizar documentacion si cambia arquitectura, flujo o contrato publico.
5. Validar con `npm run typecheck` y `npm run build` cuando aplique.
