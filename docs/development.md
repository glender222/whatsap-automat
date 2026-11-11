# Desarrollo reproducible en Linux

La laptop Linux y la VM Linux de Azure usan la misma entrada: `./dev` desde la raíz de `main`. El host solo necesita Git, Docker Engine y Docker Compose v2, además de permiso para usar el daemon de Docker. La preparación inicial necesita red para descargar imágenes y dependencias. No requiere Node.js, npm, Python, PostgreSQL, FFmpeg, Playwright ni VS Code en el host.

## Primer arranque

```bash
git clone --branch main https://github.com/glender222/whatsap-automat.git
cd whatsap-automat
./dev setup
./dev up
./dev doctor
```

`setup` construye la imagen de desarrollo e instala dependencias desde los lockfiles. Si el entorno ya estaba levantado, detiene la API y la web mientras reinstala; vuelve a ejecutar `up` después. Conserva la configuración ya generada y los archivos `.env` existentes del repositorio.

La imagen incluye Node.js 22.23.4, Python 3.12.16, FFmpeg/ffprobe y las bibliotecas necesarias para el navegador. Las imágenes de Node.js, Python y PostgreSQL 16 se fijan por digest en `.dev/versions.env`; `.dev/Dockerfile` define las herramientas de desarrollo. `setup` instala Chromium de la versión de Playwright del lockfile en el volumen `browser-cache`. Las dependencias npm se instalan con `npm ci`; las de Python usan `.dev/python-requirements.lock` y el entorno virtual `/opt/venv` del contenedor.

`setup` arranca PostgreSQL, aplica las migraciones y prepara datos sintéticos de dos empresas de forma idempotente. `up` levanta la API y la web con esa base preparada. La web usa la API real, JWT y PostgreSQL con RLS; no usa una API simulada. Las credenciales y los tokens locales no autorizan llamadas a servicios externos.

| Servicio | Dirección predeterminada |
| --- | --- |
| Web | `http://localhost:5173` |
| API disponible | `http://localhost:3000/ready` |
| Documentación de API | `http://localhost:3000/api/v1/docs` |

Inicia sesión en la web con `demo@automat.local` y `Demo-local-2026!`. Estas credenciales pertenecen exclusivamente a la demo local.

## Configuración, puertos y persistencia

`setup` genera `.dev/local/dev.env` con permisos `0600`; `.dev/local/` está excluido de Git. Ese archivo contiene la configuración privada de este entorno. No copies ahí credenciales de producción. `setup` no sobrescribe un archivo ya existente ni modifica los `.env` de la API o de la web.

Los puertos se publican en `127.0.0.1`. Si están ocupados, cambia estas entradas en `.dev/local/dev.env` antes de `up`:

```dotenv
DEV_WEB_PORT=5174
DEV_API_PORT=3001
```

Los puertos alternativos también se usan para la configuración web y las comprobaciones. Si cambias los puertos de un entorno levantado, ejecuta `./dev down` y después `./dev up`.

En el primer `setup`, la identidad de Compose se deriva de la ruta absoluta del checkout y se guarda como `DEV_PROJECT_NAME` en `.dev/local/dev.env`. Cada clon o worktree nuevo usa sus propios servicios y volúmenes de base de datos y dependencias. Conservar ese archivo conserva la identidad incluso si mueves el directorio; no lo copies a otro checkout. Para ejecutar dos entornos al mismo tiempo, configura puertos distintos.

`./dev down` conserva los volúmenes. `./dev restart` reinicia la API y la web y espera su disponibilidad, sin volver a sembrar ni reiniciar la base de datos. No existe un borrado implícito de datos. Conserva `.dev/local/dev.env` junto con el checkout para volver a abrir su base con las mismas credenciales.

## Comandos habituales

| Comando | Resultado |
| --- | --- |
| `./dev setup` | Prepara imagen, configuración privada, dependencias, migraciones y datos demo; detiene API y web durante la instalación. |
| `./dev up` | Levanta API y web con la base ya preparada por `setup`. |
| `./dev doctor` | Comprueba herramientas, configuración y disponibilidad del entorno. |
| `./dev check` | Valida contratos, SDK, CLI, backend, frontend y Python; comprueba guardas de demo y migraciones. |
| `./dev smoke` | Comprueba la UI con la API real, aislamiento entre empresas y datos persistidos después de reiniciar. Requiere `up`. |
| `./dev restart` | Reinicia API y web y espera que estén disponibles. |
| `./dev logs` | Sigue logs de API y web; acepta `api`, `web` o `postgres`. |
| `./dev shell` | Abre Bash en el contenedor; acepta un comando y sus argumentos. |
| `./dev down` | Detiene los servicios conservando volúmenes. |

Antes de un PR, ejecuta `./dev check` y `./dev smoke`. El workflow [Development environment](../.github/workflows/development.yml) recorre `setup`, `up`, `doctor`, `check` y `smoke` desde un checkout limpio, sin instalar lenguajes en el host. Su runner es efímero; el comando de cierre conserva los volúmenes hasta que termina ese runner.

Si una dependencia cambia, actualiza el manifiesto y su lockfile dentro de `./dev shell` y vuelve a ejecutar `./dev setup` y `./dev up`. No copies `node_modules` ni entornos virtuales del host al contenedor.

## Azure y acceso remoto

En una VM Linux nueva, instala Git, Docker Engine y Compose v2, clona con una cuenta autorizada y ejecuta los mismos comandos. El usuario SSH debe tener acceso al daemon de Docker. No es necesario abrir los puertos de aplicación en el grupo de seguridad de Azure.

Desde tu laptop, crea un túnel hacia la VM (ajusta host, usuario y puertos si cambiaste los valores):

```bash
ssh -N -L 5173:127.0.0.1:5173 -L 3000:127.0.0.1:3000 usuario@host-azure
```

Abre `http://localhost:5173` en la laptop. El túnel sirve para la demo y revisión de desarrollo; no crea un endpoint público estable para webhooks.

En una VM Azure que ya tiene una API, variables de proveedor y webhooks estables, usa otro checkout y puertos libres para esta demo. Conserva los `.env`, procesos, dominio y proxy existentes. `./dev` no importa esas credenciales ni migra el tráfico. La adopción por el servicio existente requiere una operación explícita con respaldo de su base, revisión de migraciones, configuración de secretos y validación del endpoint de webhook. Esta guía no reemplaza ese despliegue.

## Proveedores reales: habilitación explícita

La demo predeterminada utiliza tokens sintéticos y no activa Meta, OpenAI ni Mercado Pago al clonar, ejecutar `setup` o ejecutar `up`. Las comprobaciones locales no acreditan envíos reales, webhooks públicos, cobros ni dispositivos móviles.

Para una prueba autorizada con proveedores reales, usa un entorno de integración separado y la configuración documentada en [WhatsaapWeb-JS/.env.example](../WhatsaapWeb-JS/.env.example), [la guía del backend](../WhatsaapWeb-JS/README.md) y el [plan de validación de producto](roadmap/PRODUCT_VALIDATION_PLAN.md). Configura credenciales de prueba, claves de cifrado independientes, permisos por empresa y las habilitaciones de cada proveedor. Conserva las URL HTTPS estables y firmas de webhook que use ese entorno. No reutilices las credenciales de la demo ni ejecutes `smoke` contra producción.

## Móvil y Temporal opcionales

Las dependencias Expo se instalan solo cuando las pides:

```bash
./dev mobile web
./dev mobile check
```

La CLI admite únicamente `web` y `check`. Las compilaciones nativas Android e iOS tienen un recorrido separado y requieren sus SDK y herramientas de plataforma; consulta [apps/mobile/README.md](../apps/mobile/README.md). La instalación inicial de móvil no forma parte de `setup`.

Temporal también se levanta explícitamente:

```bash
./dev temporal up
./dev temporal down
```

El perfil levanta solo la infraestructura de Temporal y conserva su PostgreSQL separado del PostgreSQL de negocio. No se activa con `./dev up` ni arranca el worker de automatizaciones. La aplicación mantiene su configuración de flujos; para ejecutar su worker explícitamente, consulta la [guía de Temporal](../deploy/temporal/README.md). El perfil de desarrollo no configura Temporal de producción.

La configuración opcional en `.devcontainer/` reutiliza la imagen y el entorno de este checkout. Ejecuta primero `./dev setup` en el host Linux y después abre el contenedor con un editor compatible. La configuración apunta a `.dev/local/compose.resolved.yaml`, generado por `setup`; vuelve a ejecutar `setup` si necesitas regenerarlo después de cambiar el entorno. Este archivo resuelto contiene configuración privada: no compartas ni versiones `.dev/local/`. La CLI sigue siendo suficiente y no requiere VS Code.

## Diagnóstico

Si Docker no responde, comprueba el daemon y los permisos del usuario antes de `setup`. Si un puerto está ocupado, cambia el puerto de este checkout y vuelve a arrancar. Tras una interrupción, ejecuta `./dev doctor` y consulta `./dev logs api` o `./dev logs postgres`; conserva los volúmenes para investigar. Un fallo de migración o de las pruebas devuelve un código distinto de cero; no borres la base para ocultarlo.
