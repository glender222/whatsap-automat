# Guía de inicio de Whatsap-Automat

La ruta de desarrollo actual usa `main` y el comando `./dev` en Linux, tanto en una laptop como en una VM de Azure. El tag `v0.4.0` conserva la primera release preliminar de QA y sus instrucciones históricas.

## Requisitos

- Una cuenta con acceso de lectura a `glender222/whatsap-automat` en GitHub.
- Git, Docker Engine y Docker Compose v2 en el host Linux, con acceso al daemon de Docker.
- Acceso a los registros de contenedores y paquetes durante la preparación inicial.

Node.js, npm, Python, PostgreSQL, FFmpeg y Playwright se ejecutan en contenedores. Las versiones y sumas de imagen están fijadas en el repositorio; no necesitas esas herramientas en el host.

## Instalar y arrancar

```sh
git clone --branch main https://github.com/glender222/whatsap-automat.git
cd whatsap-automat
./dev setup
./dev up
./dev doctor
```

`setup` prepara la imagen y las dependencias con sus lockfiles, aplica migraciones y carga datos de demostración de forma idempotente. Genera `.dev/local/dev.env` privado y excluido de Git, sin reemplazar archivos `.env` existentes. `up` levanta la API y la web.

La web abre en `http://localhost:5173`; usa `demo@automat.local` / `Demo-local-2026!`. La API está en `http://localhost:3000` y el visor en `/api/v1/docs`. Esta demo usa la API real con JWT y PostgreSQL con RLS, con datos sintéticos de dos empresas. No requiere claves de Meta, OpenAI ni Mercado Pago.

Para cambiar los puertos, edita `DEV_WEB_PORT` y `DEV_API_PORT` en `.dev/local/dev.env` antes de `./dev up`. Los servicios se publican solo en localhost. En Azure, accede mediante túnel SSH según la [guía de desarrollo](https://github.com/glender222/whatsap-automat/blob/main/docs/development.md).

## Comprobar y detener

```sh
./dev check
./dev smoke
./dev down
```

`check` ejecuta las validaciones de código y pruebas. `smoke` comprueba el recorrido web, aislamiento entre empresas y persistencia tras un reinicio. `down` detiene los servicios conservando los volúmenes. Cada checkout nuevo genera su propia identidad local, guardada en `.dev/local/dev.env`; conserva ese archivo con su entorno y no lo copies a otros clones.

La [guía de desarrollo](https://github.com/glender222/whatsap-automat/blob/main/docs/development.md) describe logs, shell, móvil con `./dev mobile web`, Temporal opcional y proveedores reales. Clonar o ejecutar `up` nunca habilita integraciones externas. En un Azure existente con proveedores y webhooks estables, conserva su configuración y servicios hasta completar una migración explícita.

## Consultar y enviar adjuntos

El historial de `GET /api/v1/conversations/{id}/messages` incluye los identificadores de cada mensaje y sus adjuntos. Usa ambos identificadores con `GET /api/v1/conversations/{id}/messages/{messageId}/attachments/{attachmentId}` y un JWT de la empresa.

Para enviar un archivo desde una sesión con control de la conversación y una ventana activa de WhatsApp Cloud, usa `POST /api/v1/conversations/{id}/messages/attachments`. Envía `file` y `expectedConversationVersion` en un formulario multipart y asigna un encabezado `Idempotency-Key` al intento. Si pierdes la respuesta, consulta el historial con `?clientRequestId=<clave>` y conserva la misma clave y datos si necesitas repetir la solicitud.

## Referencias

- Cuando el portal incluye el kit de desarrollo, el ZIP contiene paquetes de npm instalables para el SDK de TypeScript y la CLI, una rueda del SDK de Python y sumas SHA-256.
- El paquete de documentación incluye `openapi.v1.json` y `openapi.v1.yaml`, el contrato OpenAPI 3.1 del repositorio.
- Consulta las [versiones y artefactos de GitHub](https://github.com/glender222/whatsap-automat/releases) y los [resultados de CI](https://github.com/glender222/whatsap-automat/actions/workflows/ci.yml) del commit que uses.
- Para levantar la demo de orquestación por separado, consulta la [guía de Temporal](https://github.com/glender222/whatsap-automat/blob/main/deploy/temporal/README.md).
