<div align="center">

# Whatsap-Automat

### Tu WhatsApp, mejor conectado.

Conversaciones, agentes de IA y tu equipo, en una plataforma que puedes alojar en tu infraestructura.

[Explorar la web](http://glendervargas.me/whatsap-automat/) · [Documentación](http://glendervargas.me/whatsap-automat/docs.html) · [Release v0.4.0](https://github.com/glender222/whatsap-automat/releases/tag/v0.4.0)

[![CI](https://github.com/glender222/whatsap-automat/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/glender222/whatsap-automat/actions/workflows/ci.yml) · [Licencia MIT](LICENSE)

![Presentación de Whatsap-Automat: conversaciones, automatización y control humano](docs-site/site/assets/showcase-desktop.png)

</div>

## Del mensaje al siguiente paso

Whatsap-Automat reúne la atención por WhatsApp, el contexto comercial y la configuración de agentes. El operador puede consultar el historial, tomar el control de una conversación y continuar la atención. En Agent Studio, el equipo diseña, evalúa y publica revisiones para los perfiles de ejecución compatibles.

| Para tu equipo | Para quienes integran |
| --- | --- |
| Historial persistido y estados de entrega | API REST, OpenAPI 3.1 y eventos con Socket.IO |
| Sugerencias de IA y respuesta automática según configuración | SDK de TypeScript y Python, y CLI |
| Catálogo, pedidos y comprobantes relacionados con la atención | Contratos tipados, versiones e idempotencia en operaciones compatibles |
| Control humano, permisos y espacios por empresa | Backend Express, PostgreSQL y web React en el mismo repositorio |

### Una bandeja con contexto

Consulta las conversaciones y retoma el trabajo con el historial disponible. Las sugerencias de IA se revisan antes de enviar; el modo automático requiere una revisión publicada y vinculada a WhatsApp, junto con los permisos y el estado de conversación vigentes.

![Bandeja web con conversaciones, historial y una respuesta humana en preparación, usando datos de demostración](docs-site/site/assets/inbox-desktop.png)

### Agentes con una revisión identificable

Agent Studio permite trabajar con grafos versionados y evaluaciones. Los perfiles de texto y catálogo tienen recorridos documentados de publicación y uso en WhatsApp. La publicación conserva evidencia de la revisión y la ejecución comprueba la autoridad vigente.

![Agent Studio con grafos comerciales y herramientas de edición, usando datos de demostración](docs-site/site/assets/studio-desktop.png)

Las capturas muestran la aplicación web con datos de demostración. Explora la [presentación interactiva](http://glendervargas.me/whatsap-automat/) para ver las vistas del producto y los ejemplos de integración.

## Primera entrega de QA · v0.4.0

Esta es una **release preliminar centrada en WhatsApp**. El repositorio es privado: clonar el código y acceder a sus releases o ejecuciones de Actions requiere una cuenta de GitHub autorizada. La distribución del portal y de los artefactos se gestiona desde GitHub.

- **Web y backend:** los recorridos de QA cubren persistencia, permisos, aislamiento entre empresas, mensajería y automatización con los alcances registrados por cada suite.
- **Proveedores:** existe evidencia con servicios locales controlados y una línea real de Meta. Siguen pendientes la prueba con dos líneas reales y los pilotos autorizados de OpenAI y Mercado Pago.
- **Pagos:** el alcance disponible es la conciliación interna administrativa. Mercado Pago requiere habilitación explícita; la validación con proveedor autorizado, el checkout público y sus webhooks siguen pendientes.
- **Móvil:** la release incluye un APK Android ARM64 firmado para QA. La ejecución nativa en dispositivo queda pendiente y la compilación iOS requiere un entorno con Xcode.

El alcance de esta entrega no acredita una operación omnicanal completa ni una instalación lista para producción. Consulta el [plan de validación](docs/roadmap/PRODUCT_VALIDATION_PLAN.md) y la [evidencia del APK](docs/qa/MOBILE_ANDROID_QA_2026-11-11.md) antes de evaluar un despliegue.

## Pruébalo en tu entorno

**Requisitos:** Git autenticado con acceso al repositorio, Node.js 22 con npm y PostgreSQL 16. Instala FFmpeg y ffprobe en el servidor para inspeccionar y convertir videos de WhatsApp Cloud. Docker con Compose se usa para la demo de Temporal; el SDK de Python requiere Python 3.10 o posterior.

### 1. Clona e instala

El tag `v0.4.0` reproduce la primera versión de QA; `main` contiene el desarrollo posterior y la web.

```bash
git clone --branch v0.4.0 https://github.com/glender222/whatsap-automat.git
cd whatsap-automat

npm --prefix packages/contracts ci
npm --prefix packages/contracts run build
PUPPETEER_SKIP_DOWNLOAD=true npm --prefix WhatsaapWeb-JS ci
npm --prefix Frontend_py_whatsaapweb ci
```

Para trabajar sobre el desarrollo actual, usa `--branch main` al clonar.

### 2. Configura y migra

Crea una base de desarrollo aislada y copia los ejemplos de entorno:

```bash
cp -n WhatsaapWeb-JS/.env.example WhatsaapWeb-JS/.env
cp -n Frontend_py_whatsaapweb/.env.example Frontend_py_whatsaapweb/.env
```

En el backend, rellena `DB_*` y genera claves independientes de al menos 32 caracteres para `JWT_SECRET` y `MASTER_ENCRYPTION_KEY`. El proveedor predeterminado, WhatsApp Cloud, requiere configurar `META_*` para arrancar: usa una cuenta de prueba. Configura también una clave independiente en `META_TOKEN_ENCRYPTION_KEY` cuando corresponda al entorno de despliegue. En la web, usa `VITE_API_URL=http://localhost:3000/api` con los puertos predeterminados.

```bash
npm --prefix WhatsaapWeb-JS run db:migrate
npm --prefix WhatsaapWeb-JS run db:status
```

Comprueba que todas las migraciones figuren como aplicadas. La [guía de inicio](docs-site/content/guia-inicio.md) amplía la configuración y el envío de adjuntos.

### 3. Arranca y comprueba

Ejecuta cada proceso en su propia terminal:

```bash
# Terminal 1: API
npm --prefix WhatsaapWeb-JS run dev

# Terminal 2: web
npm --prefix Frontend_py_whatsaapweb run dev

# Comprobación de disponibilidad
curl --fail --silent --show-error http://localhost:3000/ready
```

Abre la web en `http://localhost:5173` y el visor de API en `http://localhost:3000/api/v1/docs`.

## Desarrollo y verificación

| Directorio | Contenido |
| --- | --- |
| [Frontend_py_whatsaapweb/](Frontend_py_whatsaapweb/) | Espacio de trabajo web en React, Vite y TypeScript |
| [WhatsaapWeb-JS/](WhatsaapWeb-JS/) | API, canales, runtime de agentes y persistencia |
| [apps/mobile/](apps/mobile/) | Cliente Expo y React Native |
| [packages/](packages/) | Contratos, SDK y CLI |
| [docs-site/](docs-site/) | Presentación web, documentación y descargas |

Desde la raíz, tras instalar dependencias, ejecuta las comprobaciones básicas:

```bash
npm --prefix packages/contracts test
npm --prefix WhatsaapWeb-JS run typecheck
npm --prefix WhatsaapWeb-JS run typecheck:scripts
npm --prefix WhatsaapWeb-JS test
npm --prefix Frontend_py_whatsaapweb run build
npm --prefix Frontend_py_whatsaapweb test
```

Las suites de integración requieren sus servicios y variables de entorno. Consulta los [criterios de QA](docs/qa/QA_GATES_AND_CASES.md) y los [resultados de CI del commit elegido](https://github.com/glender222/whatsap-automat/actions/workflows/ci.yml); la evidencia de proveedores y dispositivos se verifica por separado.

## Documentación y colaboración

[Blueprint v0.4](docs/architecture/BLUEPRINT_v0.4.md) · [Roadmap v1.0](docs/architecture/ROADMAP_V1.0.md) · [API y compatibilidad](docs/api/README.md) · [Temporal](deploy/temporal/README.md) · [Compilar el portal](docs-site/README.md)

Para contribuir, sigue [CONTRIBUTING.md](CONTRIBUTING.md) y el [código de conducta](CODE_OF_CONDUCT.md). Reporta vulnerabilidades por el canal privado descrito en [SECURITY.md](SECURITY.md).

El [SBOM CycloneDX](sbom.json) inventaría las dependencias npm de los seis lockfiles. Regénéralo con `bash scripts/sbom-generate.sh` y compruébalo con `node --test scripts/sbom-generate.test.cjs`; los artefactos compilados y las dependencias del sistema se auditan por separado.

Código bajo [licencia MIT](LICENSE). Consulta la [release v0.4.0 y sus artefactos de QA](https://github.com/glender222/whatsap-automat/releases/tag/v0.4.0) para evaluar una versión identificable.
