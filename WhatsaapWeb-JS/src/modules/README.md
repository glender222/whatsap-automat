# src/modules

Módulos de negocio del Core operativo.

## Boundaries
- `domain/` — entidades, value objects, reglas de negocio. Sin dependencias de Express, PostgreSQL, WhatsApp, Meta, ni `whatsapp-web.js`.
- `application/` — casos de uso, puertos (interfaces), DTOs neutros. Sin frameworks ni librerías de infraestructura.
- `infra/` — implementaciones concretas: repositorios SQL, mappers, adaptadores de canal.

## Nota temporal
`src/core/` permanece como legado de conversaciones/embrionario en PR1.  
No mover ni renombrar `src/core/` en este PR.
