# Backend WhatsApp - Codex Guide

## Prioridad

Trabaja este repositorio como backend primero. Antes de tocar frontend o integraciones externas, entiende el flujo de `WhatsaapWeb-JS`, sus rutas, servicios, migraciones y variables de entorno.

## Skills Locales

Cuando el cambio toque Meta WhatsApp Cloud API, webhooks, templates, media, errores de Graph API, phone numbers o conversaciones, consulta primero:

- `.codex/skills/whatsapp-cloud-api/SKILL.md`

Cuando el cambio toque refactor, calidad interna, legibilidad o deuda tecnica, consulta:

- `.codex/skills/clean-code/SKILL.md`

Cuando el cambio toque PostgreSQL, consultas SQL, indices, paginacion, rendimiento de queries o migraciones, consulta:

- `.codex/skills/postgresql-optimization/SKILL.md`

La skill `.codex/skills/prisma-postgres/SKILL.md` queda disponible como referencia externa, pero este backend usa `pg` y migraciones SQL, no Prisma. No introduzcas Prisma salvo que el usuario lo pida explicitamente.

## Rules

Para cualquier tarea de desarrollo, aplica:

- `.codex/rules/development-workflow.md`

Antes de cambios estructurales, refactors de capas, rutas principales, services, repositorios o modulos, aplica:

- `.codex/rules/architecture.md`

Para refactor, mantenibilidad o limpieza de codigo, aplica:

- `.codex/rules/clean-code.md`

Para autenticacion, autorizacion, secretos, webhooks, archivos o datos sensibles, aplica:

- `.codex/rules/security.md`

Para base de datos, SQL, repositorios, migraciones, indices o rendimiento de consultas, aplica:

- `.codex/rules/postgres.md`

Para Meta WhatsApp Cloud API, templates, media, webhooks o errores de Graph API, aplica:

- `.codex/rules/whatsapp-meta.md`

Para eventos en tiempo real, rooms, payloads Socket.IO o compatibilidad con frontend, aplica:

- `.codex/rules/socketio.md`

## Docs

Antes de planificar o ejecutar trabajo del Sprint 5, consulta:

- `docs/current-state.md`
- `docs/sprints/sprint-5-plan.md`

Para entender si el Sprint 4 ya esta cerrado y que entrego, consulta:

- `docs/sprints/sprint-4-cierre.md`

Para decisiones de arquitectura general, consulta:

- `docs/architecture.md`

El indice documental vive en:

- `docs/README.md`

## Stack

- Runtime: Node.js con TypeScript.
- Servidor: Express 5 y Socket.IO.
- Base de datos: PostgreSQL con migraciones SQL en `src/db/migrations`.
- WhatsApp: soporta `meta-cloud` y legado `whatsapp-web.js`.
- IA: agentes en `src/services/ai` con proveedor `opencode` por defecto.

## Comandos Base

Usa estos comandos desde `C:\whatsap\WhatsaapWeb-JS`:

```bash
npm run typecheck
npm run build
npm run db:status
npm run db:migrate
npm run dev
npm run dev:tunnel
```

Antes de entregar cambios de backend, valida al menos `npm run typecheck` y `npm run build` cuando el cambio toque TypeScript o contratos de rutas. Si el cambio toca base de datos, revisa `npm run db:status` y considera `npm run db:migrate`.

## Seguridad

- Nunca imprimas, pegues ni guardes tokens reales de Meta, JWT, claves de cifrado o credenciales de base de datos.
- Trata cualquier token compartido en chat, README o logs como expuesto.
- Cambios en `.env` requieren reiniciar el backend.
- Para Meta Cloud API, un `401 Authentication Error` casi siempre indica token vencido, revocado, incompleto o no asociado al `META_WA_PHONE_NUMBER_ID`.

## Arquitectura Esperada

- Entrada principal: `src/index.ts` llama a `startApp()` en `src/app.ts`.
- Configuracion central: `src/config/index.ts`.
- Rutas modernas:
  - `/api/auth`
  - `/api/company`
  - `/api/agents`
  - `/api/tags`
  - `/api/whatsapp`
  - `/api/webhooks/meta/whatsapp`
  - `/api/chats`
  - `/api/media`
- Mantener compatibilidad con rutas legacy solo cuando sea necesario.
- Preferir TypeScript para codigo nuevo.
- Mantener la logica de negocio en services, repositorios o modulos; evitar controladores cargados de reglas.

## Flujo Meta Cloud API

Para desarrollo local con webhook real:

1. Confirmar `.env` con `WHATSAPP_PROVIDER=meta-cloud`, `PORT=3000`, `META_GRAPH_VERSION`, `META_WA_PHONE_NUMBER_ID`, `META_WABA_ID`, `META_WEBHOOK_VERIFY_TOKEN`, `META_WA_ACCESS_TOKEN` y `WHATSAPP_API_REQUIRE_JWT`.
2. Ejecutar migraciones.
3. Levantar `npm run dev:tunnel`.
4. Configurar en Meta el callback `/api/webhooks/meta/whatsapp` con el verify token.
5. Suscribir `messages`.

## Criterios De Cambio

- Respeta la separacion entre core operativo (`src/core`), modulos (`src/modules`) y servicios externos (`src/services`).
- Si agregas endpoints, actualiza rutas y contratos con nombres consistentes.
- Si agregas persistencia, crea migracion SQL incremental y no modifiques migraciones ya aplicadas salvo que el usuario lo pida.
- Si cambias eventos Socket.IO, revisa compatibilidad con el frontend en `C:\whatsap\Frontend_py_whatsaapweb`.
- No hagas refactors grandes si el pedido es puntual.

## Entrega

Al cerrar una tarea, resume archivos tocados, comandos ejecutados y cualquier validacion pendiente.
