# Frontend WhatsApp - Codex Guide

## Prioridad

Trabaja este repositorio como frontend operativo para la plataforma WhatsApp Business. Antes de tocar UI, servicios o estado global, revisa los contratos actuales con el backend y evita acoplar el navegador a Meta, tokens o implementaciones internas del servidor.

## Rules

## Skills Locales

Cuando el cambio toque componentes React, hooks, renders, listas grandes, bundle, performance o refactors de UI, consulta primero:

- `.codex/skills/react-best-practices/SKILL.md`

Aplica solo las reglas relevantes para React/Vite. Ignora recomendaciones exclusivas de Next.js, Server Components, server actions o API routes.

Cuando el cambio toque refactor, legibilidad, nombres, separacion de responsabilidades o deuda tecnica, consulta:

- `.codex/skills/clean-code/SKILL.md`

## Rules

Para cualquier tarea de desarrollo, aplica:

- `.codex/rules/development-workflow.md`

Antes de cambios estructurales en carpetas, rutas, layouts, servicios o estado compartido, aplica:

- `.codex/rules/frontend-architecture.md`

Para cambios visuales, componentes, pantallas, estilos, Tailwind o experiencia de usuario, aplica:

- `.codex/rules/ui-design.md`
- `docs/DESIGN.md`

Para consumo de API, Axios, rutas HTTP, errores, auth o contratos con backend, aplica:

- `.codex/rules/api-contracts.md`

Para Socket.IO, mensajes en tiempo real, estados de chats o actualizaciones de conversaciones, aplica:

- `.codex/rules/realtime-state.md`

Para tokens, localStorage, permisos, datos sensibles o integracion WhatsApp, aplica:

- `.codex/rules/security.md`

Para refactor, legibilidad, tipado y deuda tecnica, aplica:

- `.codex/rules/quality.md`

## Docs

El documento de diseno vive en:

- `docs/DESIGN.md`

La documentacion de la migracion inicial a WhatsApp Business / Meta Cloud API vive en:

- `docs/implementacion1/README.md`

`DESIGN.md` no debe vivir dentro de `.codex` porque no es solo una regla para el agente: es documentacion de producto, UI y experiencia que tambien sirve para el equipo. Las reglas obligatorias que salen de ese documento si viven en `.codex/rules/ui-design.md`.

## Stack

- App: Vite + React + TypeScript.
- Estilos: Tailwind CSS, CSS global en `src/index.css`.
- Estado: Jotai y hooks locales.
- HTTP: Axios centralizado en `src/shared/axios/http.ts`.
- Tiempo real: `socket.io-client` en `src/utils/socket.ts`.
- Iconos: `lucide-react`.
- Dominio principal: mensajeria WhatsApp, configuracion, agentes/bots, estaciones, reportes y autenticacion.

## Comandos Base

Usa estos comandos desde `C:\whatsap\Frontend_py_whatsaapweb`:

```bash
npm run dev
npm run build
npm run lint
npm run preview
```

Antes de entregar cambios de frontend, valida al menos `npm run build` cuando el cambio toque TypeScript, contratos, rutas o componentes compartidos. Usa `npm run lint` cuando el cambio sea amplio o toque patrones de calidad.

## Arquitectura Esperada

- `src/factures/*`: modulos funcionales existentes. Mantener el nombre actual de carpeta para no romper imports.
- `src/shared/*`: tipos, servicios, componentes y utilidades compartidas entre modulos.
- `src/routes/*`: configuracion de rutas de la aplicacion.
- `src/jotai/*`: estado global y slices.
- `src/utils/socket.ts`: cliente Socket.IO unico.

No dupliques clientes HTTP, sockets ni tipos de WhatsApp. Prefiere extender los tipos compartidos en `src/shared/types/wsp.ts` y los servicios existentes antes de crear variantes paralelas.

## Relacion Con Backend

El frontend debe hablar con el backend propio, no con Meta directamente. Para WhatsApp:

- No llamar `graph.facebook.com` desde el navegador.
- No guardar access tokens de Meta en frontend.
- Consumir mensajes desde `/api/chats/:chatId/messages`.
- Enviar mensajes hacia `/api/chats/:chatId/messages`.
- Consumir media desde rutas internas del backend.
- Tratar Socket.IO como fuente de actualizacion en vivo, pero mantener HTTP como fuente de verdad para cargas iniciales.

## Entrega

Al cerrar una tarea, resume archivos tocados, comandos ejecutados y cualquier validacion pendiente. Si una decision de UI cambia el criterio visual del producto, actualiza `docs/DESIGN.md` o `.codex/rules/ui-design.md`.
