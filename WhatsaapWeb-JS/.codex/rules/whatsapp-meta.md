# WhatsApp Meta Cloud API Rules

Estas reglas aplican a Meta WhatsApp Cloud API, webhooks, templates, media y errores de Graph API.

## Skill Relacionada

Cuando el cambio toque Meta Cloud API, consultar:

- `.codex/skills/whatsapp-cloud-api/SKILL.md`

## Configuracion

- Usar `WHATSAPP_PROVIDER=meta-cloud` para flujo Meta.
- Leer configuracion desde `src/config/index.ts`.
- No hardcodear `META_WA_ACCESS_TOKEN`, `META_WA_PHONE_NUMBER_ID`, `META_WABA_ID`, verify token ni version de Graph API.
- Recordar que cambios en `.env` requieren reiniciar backend.

## Webhooks

- El endpoint principal es `/api/webhooks/meta/whatsapp`.
- Mantener verificacion `hub.mode`, `hub.verify_token` y `hub.challenge`.
- Suscribir y manejar el campo `messages`.
- No bloquear webhooks con JWT.
- Procesar payloads de forma idempotente cuando sea posible para evitar duplicados.

## Envio De Mensajes

- Respetar reglas de Meta: ventana de servicio de 24 horas y uso de templates cuando corresponda.
- Normalizar numeros y destinatarios antes de enviar.
- Diferenciar claramente texto libre, templates, media e interacciones.
- Si el token falla con 401, no asumir bug de codigo antes de validar token, phone number ID, permisos y app/WABA.

## Media

- Descargar media usando access token valido.
- No exponer tokens en URLs publicas o logs.
- Validar tipo, tamano y origen de archivos.
- Separar almacenamiento temporal de persistencia operativa.

## Errores Comunes

- `401 Authentication Error`: token vencido, revocado, incompleto o no asociado al phone number.
- `(#131030) Recipient phone number not in allowed list`: numero destino no permitido en modo prueba.
- Webhook recibe pero envio falla: puede ser token invalido; recibir y enviar usan caminos distintos.
- Reiniciar ngrok cambia callback URL; actualizar Meta si se usa `dev:tunnel`.

## Integracion Con Core

- Convertir payloads Meta a modelos internos antes de persistir o emitir a frontend.
- No dejar que detalles crudos de Meta contaminen contratos internos si existe mapper.
- Mantener compatibilidad con conversaciones, mensajes, contactos y media del core operativo.

