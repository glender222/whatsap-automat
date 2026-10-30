# Clean Code Rules

Estas reglas aplican a legibilidad, mantenibilidad y refactor.

## Principios

- Hacer el cambio mas pequeno que resuelva el problema.
- Preferir claridad sobre abstraccion prematura.
- No esconder reglas de negocio en helpers genericos.
- No duplicar logica critica de negocio, autenticacion, persistencia o proveedores WhatsApp.
- Mantener nombres concretos del dominio: company, conversation, message, contact, tag, agent, media, webhook.

## TypeScript

- Usar TypeScript para codigo nuevo.
- Evitar `any` salvo en fronteras legacy o integraciones externas donde el tipo real sea incierto.
- Definir tipos o DTOs cuando el contrato se use en mas de un lugar.
- No introducir tipos complejos si una interfaz simple expresa mejor el contrato.

## Funciones Y Clases

- Mantener funciones enfocadas en una responsabilidad.
- Extraer helpers solo cuando reduzcan complejidad real o duplicacion clara.
- No crear capas de servicio vacias que solo reenvian parametros sin aportar validacion, transaccion o regla.
- Mantener controladores y rutas delgados.

## Errores

- Usar errores con mensajes utiles y codigos estables cuando el cliente los necesite.
- No tragar errores silenciosamente.
- No mezclar manejo de errores de infraestructura con reglas de dominio sin contexto.

## Refactor

- Refactorizar alrededor del cambio solicitado, no todo el modulo.
- Si un archivo legacy mezcla CommonJS y TypeScript, respetar el patron existente salvo que el cambio exija migrarlo.
- Mantener compatibilidad con rutas legacy si el frontend aun depende de ellas.
- Si se toca una zona frágil, validar con build/typecheck o documentar por que no se pudo.

## Comentarios

- Comentar decisiones no obvias, no instrucciones evidentes.
- Preferir nombres claros y estructura simple antes que comentarios largos.
- Documentar decisiones de arquitectura en `docs/`, no como comentarios dispersos.

