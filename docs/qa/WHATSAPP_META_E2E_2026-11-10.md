# Validación de WhatsApp Cloud API con Meta real

La prueba se ejecutó el 10 de noviembre de 2026 sobre `integration/v0.4-consolidated`, con el backend de `4ccb582`, una base PostgreSQL aislada y una línea de prueba de Meta. Las 56 migraciones se aplicaron en una base vacía. La corrección surgida de la prueba se verificó después con datos sintéticos.

| Escenario | Evidencia observada |
| --- | --- |
| Línea y cuenta de prueba | Graph devolvió HTTP 200 al consultar la línea, confirmó su pertenencia a la cuenta de prueba y devolvió `hello_world` en `en_US` como `APPROVED`. La app ya estaba suscrita a la cuenta. |
| Callback HTTPS | La ruta pública `/api/webhooks/meta/whatsapp` devolvió el `hub.challenge` exacto con HTTP 200. Otra ruta del backend devolvió 404 a través del túnel. Meta aceptó el registro y devolvió el callback activo con el campo `messages` en una segunda consulta. |
| Envío aceptado | Un administrador de la empresa de prueba envió una sola plantilla `hello_world` al destinatario autorizado en **To** por `/api/whatsapp/send-message`. El backend devolvió HTTP 200 y un identificador `wamid` de Meta. PostgreSQL registró un único mensaje saliente. |
| Entrega y lectura | El webhook verificó la firma y procesó `status.delivered`, `status.sent` y `status.read`, en ese orden, para el mismo identificador de envío. El mensaje quedó con las marcas de entrega y lectura. |
| Recepción | La respuesta «Prueba» desde el celular produjo un evento `message.text` procesado. El mensaje entrante quedó asociado a la empresa conectada y apareció en su historial por `/api/chats/:chatId/messages`, con HTTP 200 y el mismo identificador de proveedor. |
| Aislamiento con la conversación real | La segunda empresa inició sesión con su propia cuenta. Su bandeja estaba vacía, ambos endpoints de historial devolvieron 404 para la conversación de la primera y su estado de WhatsApp indicó que no tenía conexión configurada. |

La segunda empresa no tenía una segunda línea de Meta. El aislamiento de dos conexiones se probó en otro backend, con dos líneas sintéticas y RLS de PostgreSQL. Ambas empresas recibieron mensajes con el mismo contacto y `wamid`, y cada una obtuvo únicamente su historial y sus eventos Socket.IO. Desvincular una línea no interrumpió la otra. La suite HTTP con Graph simulado también comprobó que la segunda empresa no puede usar la credencial de entorno de la primera. El intento devuelve 409 sin llamar al proveedor.

Los avisos de Meta llegaron fuera de orden. La prueba de regresión reprodujo que un `sent` tardío bajaba de `delivered` a `sent` el estado visible de una plantilla. El backend ahora conserva el estado más avanzado y registra los recibos para auditoría. La corrección se verificó con la regresión de PostgreSQL, la suite de envíos canónicos y la del webhook firmado. Pasaron 20 pruebas entre las cuatro suites, sin omisiones, además de `npm run typecheck` y `npm run build`.

Al terminar se retiró el callback temporal y se cerró el túnel. Graph confirmó que el callback ya no estaba registrado y que la app seguía suscrita a la cuenta de WhatsApp. Para repetir la prueba con otra URL, véase [Configuración manual exacta en Meta Developers](../../WhatsaapWeb-JS/README.md#configuración-manual-exacta-en-meta-developers).

En una comprobación posterior, la consulta de inventario de líneas devolvió HTTP 401 y código Graph 190 con la credencial disponible. La prueba de dos líneas reales sigue pendiente. Esta comprobación fue de solo lectura.


## Revisión del panel el 11 de noviembre

La sesión del navegador permitió consultar la aplicación y WhatsApp Manager. El selector mostró una cuenta de prueba y su inventario una línea con estado Connected. El panel Step 1. Try it out mostró el campo Access Token String con el estado Not generated yet. La revisión fue de lectura del panel.

La comprobación con dos líneas reales sigue pendiente de una segunda línea configurada y del acceso de prueba vigente. El backend local conserva la evidencia separada de dos líneas sintéticas y la prueba real anterior con una línea.
