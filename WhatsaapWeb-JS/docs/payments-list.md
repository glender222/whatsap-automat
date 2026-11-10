# Lista de cobros y comprobantes

`GET /api/payments` requiere un administrador autenticado y usa la empresa del JWT. Devuelve `{ success: true, data: { rows, total, limit, offset } }`.

El filtro opcional `processStatus=collect_payment` selecciona los pedidos comerciales que esperan su primer comprobante y siguen dentro del proceso de cobro. Se aplica en PostgreSQL antes de contar y paginar, por lo que un pedido antiguo permanece accesible aunque existan más de cien comprobantes recientes. `total` cuenta todos los casos del filtro, incluyendo los de otras páginas. Las filas conservan el orden por fecha descendente y su identificador como desempate.

El parámetro existente `status=pending|validated|rejected` conserva su contrato de comprobantes. En particular, `status=pending` incluye pedidos sin comprobante y comprobantes pendientes. Ambos filtros, cuando se proporcionan juntos, se intersectan. Otros valores de `processStatus` devuelven HTTP 400. Los filtros existentes de pedido, chat, método y fechas siguen siendo combinables.

`limit` mantiene el máximo de 200 y el valor por defecto de 50; `offset` indica el desplazamiento de la página. El cliente debe reiniciar `offset` al cambiar de filtro y usar el total del servidor para habilitar la siguiente página.

La regresión `src/test/payment-process-list-postgres.test.ts` usa `PAYMENT_CHECKOUT_TEST_DATABASE_URL` contra una base local de pruebas migrada y un rol sin privilegios de superusuario ni bypass de RLS. Verifica cobros antiguos después de cien comprobantes recientes, varias páginas, totales, aislamiento por empresa y compatibilidad de los filtros anteriores.
