# Security Rules

Estas reglas aplican a secretos, autenticacion, autorizacion, webhooks y datos sensibles.

## Secretos

- Nunca imprimir, commitear ni documentar tokens reales, JWT secrets, claves de cifrado, passwords de base de datos o access tokens de Meta.
- No copiar valores reales de `.env` a README, docs, logs ni respuestas.
- Si un token fue expuesto en chat, logs o docs, tratarlo como comprometido y rotarlo.
- Usar nombres de variables y ejemplos ficticios para documentacion.

## Variables De Entorno

- Mantener credenciales en `.env`.
- No depender de valores inseguros por defecto en produccion.
- Si un cambio requiere reiniciar backend por `.env`, indicarlo al entregar.
- Validar configuracion requerida antes de usar integraciones criticas como Meta Cloud API.

## JWT Y Autorizacion

- Proteger rutas de empresa, agentes, tags y datos operativos con `requireJwt` cuando corresponda.
- Usar `optionalWhatsappJwt` solo en rutas donde la compatibilidad o el flujo actual lo justifique.
- No confiar solo en IDs enviados por el cliente; validar alcance por `companyId` o claims del usuario.
- No devolver datos de otra empresa, contacto o conversacion sin verificar pertenencia.

## Webhooks

- Mantener el verify token de Meta fuera del codigo.
- No exigir JWT a webhooks de Meta; validar por mecanismo propio del webhook.
- Si se usa `META_APP_SECRET`, preferir validacion de firma cuando el flujo lo permita.
- Guardar raw body solo para validaciones o integraciones que lo necesiten.

## Entradas Y Archivos

- Validar parametros de ruta, query y body antes de llamar servicios.
- Limitar tamanos de archivo y tipos permitidos cuando se maneje media.
- Evitar construir rutas de archivos con input sin normalizar.
- No exponer rutas internas del filesystem en respuestas de API.

## Errores Y Logs

- Los errores pueden incluir codigos tecnicos utiles, pero no secretos.
- No loguear headers completos si contienen `Authorization`.
- No loguear payloads completos de webhooks si contienen datos sensibles innecesarios.
- En produccion, devolver mensajes controlados y no stacks completos.

## Dependencias

- No agregar paquetes nuevos de seguridad, auth, cifrado o HTTP sin revisar necesidad real.
- Preferir librerias ya usadas por el proyecto: `helmet`, `cors`, `jsonwebtoken`, `bcrypt`, `express-rate-limit`.

