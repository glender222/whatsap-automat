# Guardado de revisión histórica: sincronización del E2E móvil

## Fallo observado y causa

En el CI de `9977303`, el recorrido móvil de Agent Studio no encontró «El servidor guardó esta revisión». La traza mostraba Enter sobre «Guardar borrador» unos 20 ms después de abrir el editor, sin ninguna petición POST de guardado.

El editor carga por HTTP la revisión histórica seleccionada. Mientras espera, deshabilita su `fieldset` y el manejador de guardado también comprueba ese estado. `locator.press('Enter')` puede terminar aunque el elemento esté deshabilitado: encontrar el botón no implica que el formulario esté listo. El E2E dependía de que la respuesta llegara antes que esa pulsación.

No se confirmó un defecto del producto ni un robo de foco después de habilitar el formulario. El efecto que enfoca el encabezado se ejecuta al montar el editor, no al terminar la carga.

## Reproducción roja y validación verde

Con PostgreSQL y backend locales del HEAD, se retuvo la respuesta real de `GET /api/v1/agent-graphs/qa-navigation-12?version=1`. Se comprobó que el campo y Guardar estaban deshabilitados, se pulsó Enter y se observaron cero POST. Tras liberar la respuesta, la aserción original de confirmación falló de forma determinista. El encabezado conservó el foco durante esa carga.

La prueba corregida mantiene la respuesta retenida para verificar ese límite. Después espera que Guardar esté habilitado y que el JSON sea editable, comprueba el contenido exacto de la revisión 1 y cambia `policyRef` a `qa-mobile-edited`. Tab lleva el foco del editor al botón; Enter produce un único POST con ese JSON exacto y recibe 201 para la revisión 3. La confirmación original, el regreso a la segunda página, el foco y el tema permanecen verificados.

El cambio está limitado a la prueba y esta evidencia. No se cambian el formulario, la API, sus permisos ni los tiempos máximos de las aserciones.

## Comandos

Con el entorno sintético exportado, una base PostgreSQL local independiente terminada en `_smoke` migrada hasta 068, `PRODUCT_SMOKE_URL` y `STUDIO_FIXTURE_URL` apuntando al backend y proveedor locales, desde `Frontend_py_whatsaapweb`:

```bash
npm run test:e2e -- e2e/agent-studio.integration.spec.ts -g 'Studio restores the draft list'
npx tsc --noEmit --strict --target ESNext --module ESNext --moduleResolution Bundler --lib ESNext,DOM --types node --skipLibCheck e2e/agent-studio.integration.spec.ts
npm run build
```

La regresión pasó en Chromium a 390 × 680. El typecheck estricto del E2E y la compilación TypeScript/Vite también pasaron. Los proveedores del fixture fueron locales; no se enviaron mensajes reales.
