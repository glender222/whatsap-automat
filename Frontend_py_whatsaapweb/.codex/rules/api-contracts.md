# API Contracts

## Cliente HTTP

- Usar siempre `src/shared/axios/http.ts` para llamadas al backend.
- No crear instancias Axios paralelas salvo necesidad justificada.
- No construir URLs absolutas al backend fuera del cliente central.
- Usar `VITE_API_URL` para configurar el origen del backend.

## Contratos

- Mantener los contratos tipados cerca del modulo o en `src/shared/types` si son compartidos.
- Normalizar respuestas del backend en services antes de llegar a componentes.
- No adaptar UI a estructuras accidentales de una respuesta si existe un contrato estable.
- Los cambios de endpoint deben coordinarse con el backend `C:\whatsap\WhatsaapWeb-JS`.

## WhatsApp

- Listar chats desde rutas internas del backend.
- Obtener mensajes desde `/api/chats/:chatId/messages`.
- Enviar mensajes hacia `/api/chats/:chatId/messages`.
- Resolver media desde rutas internas del backend.
- No llamar Meta Graph API desde el navegador.

## Errores

- Manejar `401` con el flujo central de refresh/logout.
- No ocultar errores de configuracion de WhatsApp; mostrarlos de forma accionable.
- Diferenciar errores de red, permisos, validacion y errores del proveedor cuando el backend lo informe.
