# Guía de inicio de Whatsap-Automat

## Requisitos

- Una cuenta con acceso de lectura a `glender222/whatsap-automat` en GitHub.
- Git, Node.js 22 con npm y PostgreSQL 16 para el entorno de desarrollo.
- Docker con Compose para la demo de Temporal y Python 3.10 o posterior para el SDK de Python.
- FFmpeg y ffprobe en el servidor para inspeccionar y convertir videos de WhatsApp Cloud.

## Instalar

Desde una terminal con GitHub autenticado, clona la rama de integración e instala los paquetes usando los archivos de bloqueo.

```sh
git clone --branch integration/v0.4-consolidated https://github.com/glender222/whatsap-automat.git
cd whatsap-automat
npm --prefix packages/contracts ci
npm --prefix packages/contracts run build
PUPPETEER_SKIP_DOWNLOAD=true npm --prefix WhatsaapWeb-JS ci
npm --prefix Frontend_py_whatsaapweb ci
```

## Configurar

Crea una base de desarrollo aislada en PostgreSQL. Copia los ejemplos sin reemplazar archivos existentes.

```sh
cp -n WhatsaapWeb-JS/.env.example WhatsaapWeb-JS/.env
cp -n Frontend_py_whatsaapweb/.env.example Frontend_py_whatsaapweb/.env
```

Rellena `DB_*` con la conexión local y genera un `JWT_SECRET` aleatorio de al menos 32 caracteres. Para una prueba con WhatsApp Cloud, configura `META_*` con una cuenta de prueba. Guarda credenciales solo en tu entorno local. Configura `VITE_API_URL=http://localhost:3000/api` en la web si usas el puerto por defecto del backend.

```sh
npm --prefix WhatsaapWeb-JS run db:migrate
npm --prefix WhatsaapWeb-JS run db:status
```

Confirma que todas las migraciones aparezcan como aplicadas. Un fallo de conexión o migración devuelve un código de salida distinto de cero.

## Arrancar y comprobar

Ejecuta los dos procesos de desarrollo en terminales separadas.

```sh
# Terminal 1
npm --prefix WhatsaapWeb-JS run dev

# Terminal 2
npm --prefix Frontend_py_whatsaapweb run dev

# Comprobación de la API
curl --fail --silent --show-error http://localhost:3000/ready
```

Con los puertos por defecto, la web queda en `http://localhost:5173` y el visor de la API en `http://localhost:3000/api/v1/docs`.

Para validar el código desde la raíz del repositorio, ejecuta las pruebas del paquete de contratos, del backend y de la web.

```sh
npm --prefix packages/contracts test
npm --prefix WhatsaapWeb-JS run typecheck
npm --prefix WhatsaapWeb-JS run typecheck:scripts
npm --prefix WhatsaapWeb-JS test
npm --prefix Frontend_py_whatsaapweb run build
npm --prefix Frontend_py_whatsaapweb test
```

## Referencias

- Cuando el portal incluye el kit de desarrollo, el ZIP contiene paquetes de npm instalables para el SDK de TypeScript y la CLI, una rueda del SDK de Python y sumas SHA-256.
- El paquete de documentación incluye `openapi.v1.json` y `openapi.v1.yaml`, el contrato OpenAPI 3.1 del repositorio.
- Consulta las [versiones y artefactos de GitHub](https://github.com/glender222/whatsap-automat/releases) y los [resultados de CI](https://github.com/glender222/whatsap-automat/actions/workflows/ci.yml) del commit que uses.
- Para levantar la demo de orquestación por separado, consulta la [guía de Temporal](https://github.com/glender222/whatsap-automat/blob/integration/v0.4-consolidated/deploy/temporal/README.md).
