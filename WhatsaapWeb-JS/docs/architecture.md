# Arquitectura General

## Propósito

`WhatsaapWeb-JS` es el backend del sistema de mensajería y operación para atención por WhatsApp. Su objetivo es centralizar conversaciones, conectar WhatsApp con una bandeja web, persistir información operativa y habilitar automatizaciones/agentes IA bajo control del negocio.

## Stack Principal

- Node.js + TypeScript.
- Express para API REST.
- Socket.IO para eventos en tiempo real.
- PostgreSQL mediante `pg` y migraciones SQL.
- Meta WhatsApp Cloud API como integración objetivo.
- `whatsapp-web.js` como integración legacy.
- Swagger para documentación de API.

## Entrada De Aplicación

- `src/index.ts`: punto de entrada mínimo; llama a `startApp()`.
- `src/app.ts`: compone Express, HTTP server, Socket.IO, middleware, Swagger, rutas, legacy routes, inicialización de DB y WhatsApp.

## Capas

### Rutas HTTP

Ubicación: `src/routes`.

Responsabilidad:

- Definir endpoints.
- Aplicar middlewares.
- Adaptar request/response.
- Delegar lógica a services, módulos o core.

Rutas principales:

- `/api/auth`
- `/api/company`
- `/api/agents`
- `/api/tags`
- `/api/whatsapp`
- `/api/webhooks/meta/whatsapp`
- `/api/chats`
- `/api/media`

### Services

Ubicación: `src/services`.

Responsabilidad:

- Integraciones operativas.
- WhatsApp provider.
- Meta Cloud API.
- IA/agentes.
- Seguridad y utilidades especializadas.

### Core Operativo

Ubicación: `src/core`.

Responsabilidad:

- Dominio de conversaciones, mensajes, contactos, empresas, adjuntos, estados y auditoría.
- Puertos de aplicación.
- Repositorios y mappers de infraestructura.
- Integración con canales externos.

### Módulos

Ubicación: `src/modules`.

Responsabilidad:

- Funcionalidades aislables por dominio.
- Empresas y conversaciones tienen módulos propios.
- Los nuevos módulos deben seguir separación domain/application/infra/presentation cuando crezcan.

### Base De Datos

Ubicación:

- `src/db/migrations`
- `src/core/infrastructure/db`
- `src/modules/*/infra/db`

Responsabilidad:

- Migraciones incrementales.
- Repositorios PostgreSQL.
- Mappers fila SQL -> entidad/DTO.
- Unit of Work cuando una operación requiera consistencia entre varias tablas.

## Integraciones WhatsApp

El backend mantiene dos caminos:

- `meta-cloud`: integración objetivo mediante Meta WhatsApp Cloud API.
- `webjs`: integración legacy mediante `whatsapp-web.js`.

La selección depende de `WHATSAPP_PROVIDER`.

Regla arquitectónica:

- No mezclar detalles internos de Meta con contratos internos de conversación.
- Usar mappers/adaptadores para convertir payloads externos a modelos internos.

## Tiempo Real

Socket.IO se usa para:

- Notificar QR/conexión.
- Emitir mensajes nuevos.
- Actualizar chats.
- Coordinar rooms por chat o contexto.

Regla:

- Socket.IO transporta eventos; la lógica de negocio debe vivir fuera del handler de socket.

## Estado Actual De Arquitectura

El Sprint 4 cerró la migración conceptual y operativa hacia Meta WhatsApp Cloud API, junto con documentación técnica, gestor de cuentas, etiquetas y adaptación de agentes/automatizaciones.

El Sprint 5 debe construir sobre esa base para agregar contexto del cliente, registro automático de pedidos/acciones, reportes exportables y métricas de horas pico.

