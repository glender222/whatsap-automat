# Recorrido operativo de aprobaciones

Base de la revisión: `dfb4a65`. Alcance: web de Aprobaciones, navegación y foco, vencimiento y recuperación. La API de producción conserva sus contratos y comprobaciones de autorización.

## Reproducciones

| Caso | Resultado antes de corregir | Comportamiento corregido |
| --- | --- | --- |
| Filtrar por riesgo bajo, página 2, abrir una solicitud y regresar | El selector vuelve a todos los riesgos y se abre la página 1. | Riesgo y página quedan en la URL; el regreso enfoca la solicitud de origen. |
| Abrir la confirmación móvil de una solicitud que vence en diez segundos | El diálogo continúa abierto después del vencimiento. | Se cierra la confirmación, se bloquean nuevas decisiones y se consulta el estado autoritativo. |
| Vencer con la confirmación abierta y fallar la siguiente consulta de estado | El foco se pierde al cerrar el diálogo. | El foco vuelve al encabezado después de desmontar el diálogo; Actualizar estado permite recuperar el resultado. |

La comprobación del vencimiento también se ejecuta justo antes de enviar una decisión, para cubrir pestañas con temporizadores suspendidos. Si ya hay una decisión en curso, su finalización conserva la responsabilidad de consultar el estado; el temporizador no introduce una consulta concurrente. La recuperación manual elimina avisos anteriores que dejaron de corresponder al estado actual.

## Composición de prueba

`Frontend_py_whatsaapweb/e2e/approvals.integration.spec.ts` usa Chromium contra la aplicación compilada y PostgreSQL reales. `WhatsaapWeb-JS/src/test/fixtures/browserApprovals.ts` registra usuarios reales y siembra solicitudes mediante el servicio HITL existente. Cada caso dispone de empresas separadas, un administrador, un empleado y una empresa ajena.

La fixture exige un backend HTTP en `127.0.0.1`, `DB_HOST=127.0.0.1`, una base terminada en `_smoke`, credenciales sintéticas del harness y un rol PostgreSQL sin superusuario ni bypass de RLS. Los modos `--expire` y `--reviewer` están limitados a registros marcados como fixtures. No se ejecutan herramientas de negocio ni se llaman proveedores externos.

Se verifican nueve casos:

- Regreso a riesgo bajo y página 2, foco y recarga, en escritorio y móvil.
- Vencimiento con confirmación móvil abierta, sin enviar una decisión.
- Vencimiento con consulta interrumpida, foco y recuperación manual.
- Rechazo con motivo obligatorio; Escape devuelve el foco sin decidir.
- Respuesta perdida antes de enviar al servidor y después del commit: mismo intento, misma clave y una transición a versión 2.
- Contraseña incorrecta y luego correcta para riesgo financiero, sin guardar contraseñas en almacenamiento del navegador.
- Empleado redirigido a Bandeja y API con 403; otra empresa con 404 y sin detalles.
- Revocación del permiso mientras la confirmación está abierta, denegación del servidor y recuperación tras restaurar el permiso.

## Ejecución

Reutilizar el entorno sintético del job de navegador en `.github/workflows/ci.yml`, con una base aislada migrada y la aplicación compilada en ejecución. El servidor usado durante esta revisión fue `http://127.0.0.1:34321`, con base `whatsap_approvals_operator_smoke`.

```bash
# Desde Frontend_py_whatsaapweb, con las variables de la base sintética exportadas.
PRODUCT_SMOKE_URL=http://127.0.0.1:34321 npm run test:e2e -- e2e/approvals.integration.spec.ts
npm run test:approvals
npm run build
npx eslint src/factures/dashboard/approvals/ApprovalDetail.tsx \
  src/factures/dashboard/approvals/ApprovalsPage.tsx \
  src/factures/dashboard/approvals/approvalNavigation.ts \
  e2e/approvals.integration.spec.ts
```

El job existente descubre automáticamente la prueba nueva. Las capturas y trazas se generan ante fallos; la fixture no imprime contraseñas ni tokens en los logs de pruebas.

Resultado local: **9/9 casos Chromium**, **4/4 pruebas unitarias de aprobaciones**, build de frontend, build/typecheck de backend y ESLint de los archivos modificados correctos. El lint global mantiene 196 errores y 9 advertencias ajenos a estos archivos. La fixture también pasa TypeScript estricto de forma aislada.
