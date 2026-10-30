# Frontend Architecture

## Estructura

- Mantener la organizacion modular actual bajo `src/factures`.
- Usar `src/shared` para piezas realmente compartidas: tipos, clientes, servicios base y componentes reutilizables.
- Evitar crear carpetas paralelas como `features` o `modules` si no se migra toda la arquitectura con intencion.
- Mantener rutas en `src/routes` y layouts en el modulo correspondiente.

## Componentes

- Separar pantallas, componentes, hooks, servicios y tipos cuando el modulo ya tenga esa estructura.
- No poner llamadas HTTP directas dentro de componentes complejos si ya existe un service o hook del modulo.
- Extraer componentes solo cuando reduzcan duplicacion real o hagan mas claro un flujo.
- Evitar componentes gigantes con UI, fetch, normalizacion, permisos y sockets mezclados.

## Tipos

- Usar TypeScript de forma explicita para contratos de API, mensajes, chats, usuarios y estados de carga.
- Centralizar tipos de WhatsApp en `src/shared/types/wsp.ts` cuando sean usados por varios modulos.
- No usar `any` salvo para fronteras inevitables; normalizar respuestas externas antes de pasarlas a UI.

## Dependencias

- Usar `axios` desde `src/shared/axios/http.ts`.
- Usar `lucide-react` para iconos.
- Usar Tailwind y clases existentes antes de introducir librerias visuales nuevas.
- No introducir dependencias de backend o WhatsApp server-side en el frontend.
