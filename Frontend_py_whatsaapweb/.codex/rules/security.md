# Frontend Security

## Secretos

- Nunca guardar tokens de Meta, app secrets, claves privadas o credenciales de base de datos en frontend.
- No llamar `graph.facebook.com` desde el navegador.
- No imprimir tokens JWT completos en consola.
- No versionar `.env` con valores reales.

## Auth

- Usar el flujo central de Axios para Authorization, refresh y logout.
- Tratar `localStorage` como almacenamiento sensible: guardar solo lo estrictamente necesario.
- Al fallar refresh token, limpiar sesion y redirigir a login.

## Permisos

- No confiar solo en ocultar botones para proteger acciones; el backend debe validar permisos.
- La UI debe reflejar permisos del usuario sin inventar roles.
- No mostrar datos de otros clientes, conversaciones o empresas si el backend no los entrega para el usuario actual.

## Archivos Y Media

- Validar tipo y tamano de archivos antes de enviar.
- Usar URLs internas del backend para media.
- No exponer rutas locales, tokens firmados largos o datos sensibles en logs visibles.
