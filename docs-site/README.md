# Web de producto y documentación

Presentación pública de Whatsap-Automat, documentación en español y descargas. Todo el código y la publicación se gestionan en este repositorio con GitHub Pages y GitHub Actions. El repositorio conserva su acceso privado; la web publicada es pública.

- `site/index.html`, `styles.css` y `showcase.js`: portada, capturas e interacciones.
- `site/docs.html`, `docs.css` y `copy.js`: instalación, arquitectura, API y alcance de la release.
- `site/assets/`: imágenes y fuentes locales, sin solicitudes a servicios de tipografía.
- `content/guia-inicio.md`: guía incluida en las descargas.
- `build.py`: compilación estática con Python 3.10 o posterior, sin dependencias adicionales.

## Compilar y abrir

Desde la raíz del repositorio:

```sh
python3 docs-site/build.py
python3 -m http.server 8080 --bind 127.0.0.1 --directory docs-site/dist
```

Abre `http://127.0.0.1:8080`. El build valida archivos, identificadores y enlaces entre páginas. Genera `downloads/whatsap-automat-docs.zip` con la guía, la licencia y los contratos canónicos OpenAPI; también permite descargar cada archivo por separado. El directorio `dist` se genera y no se versiona.

Para incluir el kit ya publicado:

```sh
gh release download v0.4.0 --repo glender222/whatsap-automat \
  --pattern 'whatsap-automat-developer-kit-v0.4.0.zip' --dir /tmp
python3 docs-site/build.py --developer-kit /tmp/whatsap-automat-developer-kit-v0.4.0.zip
```

El build comprueba las sumas internas del kit. Para crear uno nuevo desde los paquetes del repositorio, consulta `scripts/package-developer-kit.py --help`. El portal mantiene la versión del kit visible en el workflow de publicación; actualízala explícitamente al cambiar de release.

## Verificar

```sh
python3 -m unittest discover -s docs-site -p 'test_*.py'
node --check docs-site/site/showcase.js
npm --prefix Frontend_py_whatsaapweb ci
(cd Frontend_py_whatsaapweb && npx playwright install chromium)
node docs-site/test_ui.cjs
```

La prueba de navegador sirve el build en un puerto local libre y cierra sus propios procesos. Cubre tamaños de escritorio, tablet y móvil, desbordamientos, pestañas con teclado, modos de la demostración, copia, menú, movimiento reducido y contenido sin JavaScript. El build debe existir antes de ejecutarla.

## Publicar en GitHub

[Product website](../.github/workflows/pages.yml) construye y verifica la web en los PR a `main`. Publica únicamente desde `main`, con permisos de Pages y un artefacto limitado a `docs-site/dist`. Se ejecuta al cambiar la web, los contratos o la licencia, y admite ejecución manual desde Actions.

En **Settings → Pages**, la fuente es **GitHub Actions**. El despliegue usa el entorno `github-pages`; su URL aparece en Actions y en la sección About del repositorio. La cuenta hereda el dominio `glendervargas.me` desde su sitio personal. La configuración de DNS y el certificado de ese dominio se administran aparte de este proyecto.

Los enlaces al código, APK y releases requieren acceso al repositorio. Las capturas muestran datos de demostración. La página distingue la interfaz web móvil del APK ARM64 de QA y enlaza el alcance pendiente de los proveedores.

## Recursos visuales

Las capturas de Bandeja, Agent Studio y móvil proceden de la aplicación con una empresa y contactos ficticios. `showcase-desktop.png` es una captura de esta portada. La pieza original de cristal verde se creó con ImageGen para este proyecto; se distribuye como WebP optimizado, junto con el original PNG.

Geist e Instrument Serif se sirven desde `site/assets/fonts/`. Sus licencias SIL Open Font License están incluidas en ese directorio. El icono `mark.svg` pertenece al portal existente.

Las animaciones respetan `prefers-reduced-motion`; el visitante también puede pausarlas desde el pie. Las demostraciones son ilustrativas y no hacen llamadas a proveedores ni envían mensajes.
