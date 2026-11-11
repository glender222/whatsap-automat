# Revisión UX de publicación y sugerencias de WhatsApp

Candidato revisado: `62f5b58`. Alcance: Studio → Revisión para WhatsApp y Bandeja → sugerencia publicada. Se reutilizaron App, PostgreSQL, OpenAI local y Graph local del harness existente. Sin cambios de backend, CI ni registro global de evidencia.

## Reproducciones y correcciones

| Caso confirmado en Chromium | Antes | Después |
| --- | --- | --- |
| Vincular una revisión publicada, cambiar de Sugerencias a Respuestas automáticas y volver a Sugerencias; abrir la conversación sin agente legacy | Pausar IA queda deshabilitado hasta que existe una sugerencia visible. También vuelve a deshabilitarse tras aceptarla. | La conversación canónica puede pausarse antes de una sugerencia y después de aceptarla. El mensaje de pausa no depende del agente legacy. |
| Con teclado móvil, desvincular la revisión de WhatsApp | Desaparece el botón enfocado y el selector queda inactivo, sin destino de foco. | Las mutaciones confirmadas devuelven el foco al selector de modo o al encabezado cuando ese selector no está disponible. |

La primera prueba roja falló en `toBeEnabled()` de Pausar IA; después de corregirlo, la segunda reproducción falló en `toBeFocused()` del selector tras desvincular. Las restricciones y comprobaciones de permisos de la API permanecen intactas.

## Cobertura del recorrido

La prueba existente `provider mode requires a company credential and runs its published revision from Studio` se amplió sin añadir casos omitidos ni cambiar el número esperado por CI. Opera con dos empresas y viewport de 390 px:

- Crear, evaluar y publicar una revisión con credencial sintética de la empresa.
- Vincular y hacer dos cambios sucesivos con flechas/Enter, comprobando tres revisiones de concurrencia distintas y foco tras cada actualización.
- Pausar/reanudar antes de recibir una sugerencia, con estado visible.
- Recibir y recuperar por HTTP una sugerencia de la publicación, sin notificar ni mostrar texto a la otra empresa.
- Pausar con sugerencia visible y borrador manual; ocultar la sugerencia antigua y conservar el borrador al reanudar.
- Recibir una sugerencia nueva, mostrar Reemplazar borrador, copiarla con Enter y enfocar el compositor, sin enviar el mensaje.
- Pausar/reanudar después de aceptar y mantener el texto del borrador.
- Cambiar la vinculación desde otra operación, rechazar el intento obsoleto, recuperar su revisión actual y desvincular con foco restaurado.
- Conservar los casos existentes de ejecución publicada, acuse perdido, aislamiento y cambio de sesión.

## Ejecución

Usar las variables sintéticas del harness de navegador y una base migrada `_smoke` propiedad del rol de aplicación. El entorno de esta revisión fue:

```bash
export DB_NAME=whatsap_published_ux_smoke
export HOST=127.0.0.1 PORT=34441
export PRODUCT_SMOKE_URL=http://127.0.0.1:34441
export STUDIO_FIXTURE_URL=http://127.0.0.1:34442
export PRODUCT_GRAPH_FIXTURE_URL=http://127.0.0.1:34443
export STUDIO_PROVIDER_FIXTURE=1 PLAYWRIGHT_PORT=4196

# Backend, con las variables sintéticas de auth/cifrado/Meta del harness.
node --import tsx --import ./src/test/fixtures/browserGraph.mjs src/test/fixtures/browserStudio.ts

# Frontend, con el mismo entorno.
npm run test:e2e -- e2e/agent-studio.integration.spec.ts -g 'provider mode'
npm run test:agent-graphs
npm run test:canonical-inbox
npx eslint src/factures/mensajeria/components/ChatContainer.tsx \
  src/components/agent-studio/canonical/AgentGraphWhatsappBinding.tsx \
  e2e/agent-studio.integration.spec.ts
npm run build
```

Las trazas y capturas de las reproducciones se generan en `Frontend_py_whatsaapweb/test-results`. Los proveedores de estas pruebas son locales; la consulta a sus intentos de envío permanece vacía después de aceptar la sugerencia.

Resultado final: **1/1 recorrido Chromium, sin omitidos, 12,0 s**; **7/7 pruebas de Agent Studio** y **8/8 de Bandeja canónica**; ESLint de los tres archivos TypeScript modificados, build frontend y `git diff --check` correctos.
