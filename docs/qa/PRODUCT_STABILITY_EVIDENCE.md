# Evidencia de estabilidad del producto

Este registro separa los recorridos verificados y los pendientes. Para cerrar un defecto se registra la reproducción, el cambio y el resultado de la regresión. Cuando el recorrido cruza empresas, la evidencia identifica los roles y la separación comprobada.

## UX-01. El tema cambia al navegar

- **Antes.** Chromium abrió la bandeja con el sistema en Claro y la preferencia Oscuro guardada. La barra de navegación ya era visible y el documento seguía sin la clase `dark`. La prueba falló en esa aserción sobre la base `6f064ea`.
- **Causa.** El módulo de Configuración aplicaba el tema al importarse. El átomo se inicializaba con una preferencia capturada al cargar el módulo y el selector volvía a escribirla al montarse. Al cambiar la sesión se recreaba el almacén.
- **Cambio.** El documento aplica el tema antes de cargar React. El estado de apariencia se mantiene a nivel del navegador. Los cambios de sesión siguen recreando el estado de datos de la aplicación. Configuración usa un selector nativo y el selector de emojis consume el tema efectivo.
- **Después.** Tres pruebas en Chrome comprobaron el arranque antes de React, el recorrido Bandeja → Configuración → Bandeja, el cambio de sesión, la recarga, el cambio de tema del sistema y la sincronización entre pestañas. La suite del frontend pasó 72 pruebas y el build terminó correctamente.

Reproducción desde `Frontend_py_whatsaapweb`:

```sh
npm ci
npx playwright install chromium
npm run test:e2e -- e2e/theme.spec.ts
```

Para usar Chrome instalado en el sistema se puede ejecutar `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e -- e2e/theme.spec.ts`. Las pruebas de apariencia usan respuestas HTTP de prueba y dos sesiones de navegador. La comprobación de permisos entre empresas requiere API y PostgreSQL reales.

## Recorridos por cerrar

| Recorrido | Evidencia pendiente |
| --- | --- |
| Bandeja en tiempo real | Conversación nueva, filtro activo, recuperación tras corte de Socket.IO y cambios de entrega. Verificar pantalla, API y filas por empresa. |
| Envío y recepción | Reorden, duplicados, timeout, reintento, historial paginado, adjuntos, ventana de atención y toma de control. Contar las llamadas al proveedor de prueba y comprobar persistencia e identidad. |
| Harness IA | Borrador, validación, evaluación de ejecución, publicación y ejecución de una revisión inmutable. Comprobar permisos, límites, cancelación, recuperación y efectos concurrentes. |
| Flujo operativo y navegación | Atención, pedido, pago, aprobación y conexión. Recorrer como administrador y operador, con teclado y diferentes tamaños de pantalla. |
