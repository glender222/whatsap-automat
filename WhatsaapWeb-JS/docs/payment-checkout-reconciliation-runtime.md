# Conciliación operativa de Mercado Pago Orders

La ruta `POST /api/payments/checkout-intents/:intentId/reconcile` requiere el JWT de un administrador activo de la empresa. El cuerpo puede quedar vacío cuando el despacho ya tiene el ID remoto. Si se perdió el acuse, el servidor busca por referencia. Para aportar un ID directamente, envía `{ "providerOrderId": "<id de Mercado Pago>" }` con el ID localizado en el panel autorizado. El servidor recupera la intención y el despacho de la empresa autenticada y verifica el ID con el proveedor. Si la búsqueda no identifica una orden única, la respuesta indica revisar el panel y aportar el ID. Repetir la conciliación consulta el estado sin crear otra orden.

La pasarela Mercado Pago activa debe conservar la revisión exacta registrada en la intención. Sus credenciales cifradas incluyen `access_token` y `seller_id` como cadenas. Usa el identificador del vendedor que Mercado Pago devuelve como `user_id`. El almacén autentica el contenido y comprueba su empresa, pasarela y propósito. Una edición o rotación invalida la revisión antigua. En ese caso, coteja el despacho en el panel de Mercado Pago con el vendedor autorizado y conserva el registro local para revisión. [Campos de Mercado Pago Orders](https://www.mercadopago.com.pe/developers/es/docs/checkout-pro-orders/create-order)

Configura la pasarela con `POST /api/agents/payment-gateways` o modifica sus credenciales con `PATCH /api/agents/payment-gateways/:id`. Ambas rutas requieren un JWT de administrador. El cuerpo de creación tiene esta forma con valores ficticios.

```json
{
  "provider": "mercadopago",
  "displayName": "Mercado Pago Perú",
  "credentials": {
    "access_token": "<token privado de la aplicación>",
    "seller_id": "<identificador numérico del vendedor>"
  }
}
```

Para actualizar las credenciales, envía ambos campos juntos antes de preparar nuevas intenciones. Las respuestas indican si hay credenciales guardadas sin devolver sus valores. Usa TLS para enviar la configuración y evita guardar el token en el historial del shell.

El valor predeterminado de `MERCADOPAGO_RECONCILIATION_ENABLED` es deshabilitado. El endpoint devuelve 501 hasta que el operador de despliegue active el valor literal `true`. Mantén el valor deshabilitado hasta probar con una cuenta autorizada de Mercado Pago Perú y aplicar las migraciones de despacho y conciliación. El transporte del endpoint solo consulta Orders por GET en la API de Mercado Pago.

La respuesta incluye el último estado registrado, el importe, el estado del proveedor, la fecha de observación y, cuando corresponde, la primera fecha de liquidación o el motivo de revisión. Una consulta posterior puede quedar obsoleta y devolver 409. Un estado remoto sin verificar, una credencial inaccesible o una falla del proveedor devuelve 503 y permite una nueva consulta. La creación de checkout para compradores y el webhook de cobros siguen deshabilitados.
