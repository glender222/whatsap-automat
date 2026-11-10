# Configuración y recuperación de la conexión WhatsApp

Base de la reproducción: `dfb4a65`. Las pruebas usan PostgreSQL con RLS y un servidor Graph local; no envían mensajes ni usan credenciales de Meta reales.

## Defectos reproducidos

1. Dos administradores podían guardar la conexión de sus empresas desde Configuración, pero la pantalla no ofrecía diagnóstico ni desconexión. El recorrido Chromium fallaba esperando «Comprobar conexión» después de guardar ambas conexiones.
2. Un rechazo de la credencial por Meta aparecía como `Request failed with status code 403`, sin instrucciones de recuperación. La regresión exige explicar que deben revisarse la línea, el token y sus permisos.

## Comportamiento corregido

- El diagnóstico usa los contratos existentes de `/api/v1/channel-connections`: localiza la línea de la empresa activa, pagina si es necesario y rechaza respuestas de otra empresa. La comprobación consulta Meta desde el backend y muestra el resultado y la fecha.
- Los administradores pueden desconectar mediante un diálogo con foco inicial en Cancelar y retorno de foco al cerrar con Escape. La UI solo confirma el éxito después de recibir la confirmación del servidor. Un error permite actualizar el estado y reintentar explícitamente.
- La reconexión exige una credencial nueva cuando no existe una activa. Guardar, comprobar y desconectar se excluyen entre sí en la pantalla. El formulario limpia el secreto al guardar o desconectar.
- Los empleados pueden leer el estado; no reciben controles de administración. El servidor también rechaza sus operaciones de guardado, comprobación y desconexión.

## Cobertura

`Frontend_py_whatsaapweb/e2e/whatsapp-settings.integration.spec.ts` recorre la aplicación real con dos empresas, escritorio y móvil:

- Guardado, diagnóstico satisfactorio, autorización revocada y credencial de reemplazo rechazada.
- Cancelación por teclado, fallo HTTP de desconexión, reintento explícito, revocación confirmada y reconexión.
- Indisponibilidad temporal de Graph y recuperación sin sustituir la credencial.
- Ausencia de cambios en la segunda empresa; un ID de conexión ajeno devuelve 404 aunque se envíe otro tenant por cabecera/cuerpo.
- EMPLEADO recibe 403 en las tres operaciones administrativas, además de no ver sus controles en la UI.
- Cambiar de empresa descarta el borrador de credencial y una respuesta tardía del resumen anterior no sustituye la empresa activa.
- El fixture no recibe operaciones de envío de mensajes.

Las pruebas existentes de `channel-connections-postgres.test.ts` añaden cifrado, FORCE RLS, paginación, diagnóstico sanitizado, comprobaciones superadas por una rotación y ausencia de llamadas Graph después de revocar.

## Ejecución

Usar una base local migrada con nombre terminado en `_smoke`, un rol sin superusuario ni bypass de RLS y el entorno sintético del smoke de producto. El fixture exige `HOST=127.0.0.1`, `DB_HOST=127.0.0.1`, `WHATSAPP_PROVIDER=meta-cloud`, `META_WA_ACCESS_TOKEN=synthetic-local-token` y URLs locales en `PRODUCT_SMOKE_URL` y `PRODUCT_GRAPH_FIXTURE_URL`. `PORT` debe coincidir con el puerto del backend.

```bash
# WhatsaapWeb-JS
npm run db:migrate
npm run build
node --import ./src/test/fixtures/browserGraph.mjs dist/index.js

# Frontend_py_whatsaapweb, con el mismo entorno sintético
npm run test:e2e -- e2e/whatsapp-settings.integration.spec.ts
npm run build

# WhatsaapWeb-JS, conexión sintética en CHANNEL_CONNECTIONS_TEST_DATABASE_URL
node --import tsx --test src/test/channel-connections-postgres.test.ts
```

CI ya descubre el nuevo spec dentro de la suite de navegador y precarga `browserGraph.mjs`. No requiere variables nuevas. Los endpoints `/connection-fixture/:line` existen solamente dentro de ese fixture local para simular autorización e indisponibilidad; no se añaden rutas al producto.

Resultado local: tres recorridos Chromium y dos pruebas HTTP/PostgreSQL pasan, sin casos omitidos. La validación comprueba la integración y el aislamiento con Graph sintético; no constituye una comprobación de una cuenta real de Meta.
