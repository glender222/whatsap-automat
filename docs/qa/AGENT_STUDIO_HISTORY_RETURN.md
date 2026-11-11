# Regreso por historial en Agent Studio

Revisión independiente sobre `fa159d8`, comparada con `3eb55ff`. La aplicación real, PostgreSQL aislado y los transportes de Studio/Graph locales ejecutan el recorrido; no se utilizan credenciales ni proveedores reales.

## Reproducción y resultado

1. Crear 25 borradores ordenados `back-00` a `back-24` y abrir la página 2 (`?after=back-11`).
2. Con teclado, abrir el último borrador de la página (`back-23`).
3. Recargar el detalle y usar Atrás del navegador.

En ambos commits, Atrás conserva el cursor pero pierde el foco y el desplazamiento. En móvil de 390 × 680, el foco queda en `BODY`, el panel vuelve a `scrollTop=0` y la tarjeta queda entre `y=2212` y `2366`, fuera del panel visible (`64–680`). La regresión de navegador falló en la comprobación de foco antes de corregirlo.

La corrección devuelve el foco al enlace utilizado y restaura la posición del panel. En esa reproducción, el desplazamiento recuperado es `1766` y la tarjeta queda entre `446` y `600`. La prueba comprueba foco, geometría dentro de `main`, ausencia de elementos superpuestos y de desbordamiento horizontal, además del valor de desplazamiento.

El cotejo también confirma la mejora ya presente en `fa159d8`: Anterior/Siguiente/Última revisión y edición/cancelación conservan `after`. En `3eb55ff`, Anterior eliminaba ese cursor. El primer Tab del editor llega a su enlace de regreso visible en ambas versiones; no se ha cambiado ese comportamiento.

## Alcance de la solución

- El registro de cada entrada contiene solamente la clave de historial, el cursor, el identificador de grafo (o el destino Nuevo grafo) y la posición del panel.
- `sessionStorage` conserva como máximo 20 entradas. La lectura exige coincidencia de `browserSessionId`, usuario y empresa; el identificador opaco de sesión se obtiene del módulo de autenticación. No se guardan tokens, nombres, políticas ni especificaciones de grafos.
- La clave compartida inicial `default` se sustituye con una clave de entrada propia sin crear otro paso de historial. Una nueva URL directa no reutiliza la posición de una entrada anterior. Recargar el detalle mantiene su `history.state.key`, comprobado en Chromium.
- POP consulta exclusivamente el registro de la sesión vigente. El estado de un regreso explícito anterior no sustituye al último enlace utilizado ni filtra contexto tras cambiar de empresa.
- Una segunda reproducción cambió de empresa con la lista ya abierta tras un regreso explícito. La tarjeta de la empresa nueva recibía el foco por el estado anterior de React Router. Ahora los enlaces de regreso llevan el identificador opaco de sesión y la lista solo aplica ese foco a la sesión que lo inició. El navegador verifica también que la posición de la nueva empresa permanezca al inicio.
- La restauración se realiza una vez por entrada cuando llegan sus resultados. Un destino ausente utiliza el resumen de resultados; almacenamiento bloqueado o inválido no interrumpe la navegación.

## Cobertura y ejecución

`e2e/agent-studio-navigation.integration.spec.ts` cubre cinco recorridos:

- Regreso explícito, historial, recarga, edición/cancelación, creación/cancelación y enlaces directos válidos e inválidos: escritorio oscuro y móvil claro, ambos con preferencia del sistema opuesta.
- Atrás/Adelante, recarga de detalle y lista, segundo borrador después de un regreso explícito, creación/recarga/Atrás y URL directa con el mismo cursor: escritorio y móvil.
- Dos empresas con los mismos IDs de grafo. Se cambia de empresa desde el detalle y desde la lista después de un regreso explícito. Se comprueba además un nuevo inicio de sesión de la misma empresa y que cada sesión pueda guardar su propia posición.

Las pruebas unitarias adicionales comprueban renovación frente a nuevo inicio de sesión, aislamiento por entrada/cursor/empresa, límite de retención, registros inválidos y almacenamiento bloqueado. Se conservan las pruebas de API y sesión existentes.

Con las variables sintéticas del harness ya cargadas y una base `_smoke` propiedad del rol de aplicación (migraciones hasta 063), usar este entorno compartido en ambos procesos:

```bash
export DB_NAME=whatsap_studio_navigation_review_smoke
export HOST=127.0.0.1 PORT=34461 PLAYWRIGHT_PORT=4208
export PRODUCT_SMOKE_URL=http://127.0.0.1:34461
export STUDIO_FIXTURE_URL=http://127.0.0.1:34462
export PRODUCT_GRAPH_FIXTURE_URL=http://127.0.0.1:34463
unset STUDIO_PROVIDER_FIXTURE
```

Desde `WhatsaapWeb-JS`, iniciar el backend de verificación:

```bash
node --import tsx --import ./src/test/fixtures/browserGraph.mjs src/test/fixtures/browserStudio.ts
```

Desde `Frontend_py_whatsaapweb`:

```bash
npm run test:e2e -- e2e/agent-studio.integration.spec.ts e2e/agent-studio-navigation.integration.spec.ts
npm run test:agent-graphs
npm run test:auth-session
npx eslint src/components/agent-studio/canonical/AgentGraphListPage.tsx \
  src/components/agent-studio/canonical/studioListHistory.ts \
  src/shared/auth/session.ts src/shared/types/user.types.ts \
  src/__tests__/agent-graphs.test.ts e2e/agent-studio-navigation.integration.spec.ts
npm run build
```

Validación local final: **7/7 recorridos Chromium** (cinco nuevos y los dos existentes del perfil de verificación), **10/10 pruebas de grafos**, **10/10 de sesión**, ESLint de los archivos afectados sin incidencias y build de producción exitoso. El build mantiene los avisos de tamaño de chunks preexistentes. Las capturas de los regresos se guardan en los artefactos Playwright.

Límite: Chromium automatizado, no revisión manual de Safari/Firefox ni lector de pantalla. Atrás se ejecuta mediante `page.goBack()` sobre el historial real, porque Alt+Izquierda no activa el acelerador del navegador en Chromium headless. La revisión de publicación usa el perfil de verificación ya existente; esta corrección no altera perfiles de producción, backend, CI ni permisos.
