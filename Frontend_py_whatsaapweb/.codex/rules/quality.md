# Quality Rules

## Clean Code

- Nombrar componentes, hooks, servicios y tipos segun su responsabilidad real.
- Mantener funciones pequenas y con una sola razon principal para cambiar.
- Evitar duplicacion de normalizadores, clientes HTTP, sockets y tipos.
- Preferir claridad sobre abstracciones prematuras.

## TypeScript

- No usar `any` para evitar resolver un contrato; crea o ajusta tipos.
- Tipar props, respuestas de services y estados complejos.
- Si una respuesta backend es flexible, normalizala a un tipo estable antes del render.

## React

- Evitar efectos con dependencias incompletas.
- Limpiar timers, listeners y subscripciones.
- Evitar renders costosos en listas grandes de chats o mensajes.
- Mantener handlers asincronos con manejo de error visible o trazable.

## Logs

- Remover logs ruidosos antes de cerrar trabajo estable.
- Mantener logs solo cuando ayuden a diagnosticar flujos dificiles y no expongan datos sensibles.
