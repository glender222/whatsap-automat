# Realtime And State

## Socket.IO

- Usar el cliente unico definido en `src/utils/socket.ts`.
- No abrir multiples conexiones Socket.IO desde componentes hijos.
- Suscribirse y limpiar listeners dentro de hooks o efectos controlados.
- Mantener compatibilidad con eventos actuales: `message`, `chats-updated`, `ready`, `disconnected` y `state_changed`.

## Fuente De Verdad

- Usar HTTP para carga inicial y recuperacion confiable.
- Usar Socket.IO para actualizaciones en vivo y mejora de latencia.
- Evitar que un evento socket deje la UI en un estado imposible de reconciliar con la API.

## Mensajeria

- Normalizar timestamps antes de ordenar o renderizar mensajes.
- Evitar duplicados entre mensajes optimistas, respuesta HTTP y eventos socket.
- Mantener estados de envio, error, media y lectura de forma visible cuando aplique.
- No mezclar IDs legacy `@c.us` con IDs Meta sin normalizacion explicita.

## Jotai Y Hooks

- Usar Jotai para estado global real: auth, tema, transiciones o datos compartidos.
- Preferir hooks locales para estado de una pantalla.
- No guardar datos sensibles completos en estado global si no son necesarios para render.
