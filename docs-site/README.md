# Portal de documentación de Whatsap-Automat

Portal estático en español con instalación, arquitectura, referencia de API y descargas. La compilación usa Python 3.10 o posterior y su biblioteca estándar.

## Compilar y abrir

Desde la raíz del repositorio:

```sh
python3 docs-site/build.py
python3 -m http.server 8080 --bind 127.0.0.1 --directory docs-site/dist
```

Abre `http://127.0.0.1:8080`. El build comprueba los enlaces locales y genera `docs-site/dist/downloads/whatsap-automat-docs.zip` a partir de la guía, la licencia y los contratos canónicos OpenAPI. Los mismos documentos también se descargan por separado desde la web. Al cambiar instrucciones de instalación, revisa `site/index.html` y `content/guia-inicio.md`.

Para añadir el kit de desarrollo, instala las dependencias de `packages/contracts`, `packages/sdk` y `packages/cli` con `npm ci` en cada directorio. Después compila el kit en un entorno Python con pip.

```sh
python3 scripts/package-developer-kit.py --output /tmp/whatsap-automat-developer-kit.zip
python3 docs-site/build.py --developer-kit /tmp/whatsap-automat-developer-kit.zip
```

El portal comprueba las sumas del kit y publica la descarga junto con la documentación.

## Distribución

Sirve `docs-site/dist/` en un host estático con el acceso que corresponda al equipo. En un repositorio privado, usa un host privado o publica un artefacto de CI restringido a las personas con acceso. El ZIP del portal lleva solo documentación. Los enlaces al código fuente y a las versiones requieren los permisos de GitHub del visitante.

Publica archivos instalables en GitHub Releases cuando exista una versión con artefactos verificados. Conserva el repositorio y sus archivos de entorno fuera del directorio publicado.
