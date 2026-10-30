# Implementacion 1 - Terranas: Frontend WhatsApp Business

Fecha de corte: 2026-05-12

Este documento define como debe quedar el frontend durante la primera migracion hacia WhatsApp Business Platform / Cloud API de Meta. El frontend no debe conocer tokens de Meta ni llamar directamente a `graph.facebook.com`; todo debe pasar por el backend.

## Estado actual del proyecto

El frontend `silvaprojets` usa:

- Vite + React.
- `axios` centralizado en `src/shared/axios/http.ts`.
- `socket.io-client` en `src/utils/socket.ts`.
- Servicios de WhatsApp en:
  - `src/factures/setting/services/whatsappService.ts`
  - `src/factures/mensajeria/services/messageService.ts`
  - `src/factures/mensajeria/services/mediaService.ts`
- Eventos Socket.IO: `message`, `chats-updated`, `ready`, `disconnected`, `state_changed`.
- Algunas rutas antiguas bajo `/whatsapp/...` todavia aparecen en servicios y comentarios.

Aunque `package.json` incluye `whatsapp-web.js` y `qrcode`, el frontend no deberia necesitarlos. La libreria de WhatsApp debe vivir solo en backend o ser retirada cuando ya no se use.

## Regla principal

No guardar ni usar en frontend:

- Access token de Meta.
- App secret.
- WABA ID como dato sensible operativo.
- Phone Number ID como configuracion editable por usuario final.

El navegador solo debe hablar con el backend propio usando JWT del sistema.

## Contrato que debe consumir el frontend

Para evitar acoplar UI a `whatsapp-web.js` o a Meta, el frontend debe depender de estas rutas internas:

| Pantalla/flujo | Ruta frontend esperada | Observacion |
| --- | --- | --- |
| Estado de canal | `GET /api/whatsapp/status` | En WebJS puede indicar QR; en Meta indica configuracion y webhook |
| Numero afiliado | `GET /api/whatsapp/me` | En Meta devuelve numero de negocio o phone display |
| Inicializar canal | `POST /api/whatsapp/init` | En Meta valida credenciales/configuracion; no genera QR |
| Cerrar/desactivar | `POST /api/whatsapp/logout` | En Meta no revoca token por si solo; marca canal desactivado localmente |
| Listar chats | `GET /api/chats` o `GET /api/whatsapp/chats` | Debe venir de BD propia, no de "listar WhatsApp" |
| Obtener mensajes | `GET /api/chats/:chatId/messages` | Fuente principal: BD propia |
| Enviar mensaje | `POST /api/chats/:chatId/messages` | El backend decide si usa Meta o WebJS |
| Media | `GET /api/media/:messageId` | Backend resuelve cache/local/Meta |

Brecha detectada: `src/factures/setting/services/whatsappService.ts` llama rutas `/whatsapp/...`, pero el backend actual expone principalmente `/api/auth/...`, `/api/chats/...`, `/api/media/...` y rutas legacy. Antes de cambiar UI, conviene que el backend agregue el facade `/api/whatsapp/*`.

## Cambios de UX al pasar a Meta Cloud API

En `whatsapp-web.js`, la afiliacion se basa en QR. Con Meta Cloud API, el usuario no escanea QR dentro de esta app:

- El numero se configura en Meta Business / Developer Dashboard.
- El backend guarda `phone_number_id`, `waba_id` y token en variables seguras.
- La pantalla de configuracion debe mostrar estado del canal, numero conectado y errores de configuracion.
- El boton "Afiliar" o "Inicializar" debe cambiar de significado: validar configuracion del backend y webhook, no pedir QR.

Estados recomendados:

```ts
type WhatsAppProvider = 'webjs' | 'meta-cloud';

type WhatsAppChannelStatus = {
  provider: WhatsAppProvider;
  configured: boolean;
  connected: boolean;
  phoneNumber?: string;
  phoneNumberId?: string;
  wabaId?: string;
  qr?: string;
  webhookVerified?: boolean;
  message?: string;
};
```

Reglas de render:

- Si `provider === 'webjs'` y `qr` existe, mostrar QR.
- Si `provider === 'meta-cloud'`, no mostrar QR; mostrar estado de configuracion y webhook.
- Si `configured === false`, mostrar error accionable para administrador.
- Si hay `connected === true`, permitir entrar a mensajeria.

## Ajustes recomendados en servicios

`src/factures/setting/services/whatsappService.ts` debe normalizar respuestas para ambos proveedores:

```ts
static async checkConnectionStatus(): Promise<WhatsAppChannelStatus> {
  const { data } = await api.get('/whatsapp/status');
  return {
    provider: data.provider ?? 'webjs',
    configured: Boolean(data.configured ?? data.connected),
    connected: Boolean(data.connected),
    phoneNumber: data.phoneNumber ?? data.numero ?? null,
    phoneNumberId: data.phoneNumberId,
    wabaId: data.wabaId,
    qr: data.qr,
    webhookVerified: data.webhookVerified,
    message: data.message,
  };
}
```

`src/factures/mensajeria/services/messageService.ts` ya usa el contrato correcto para mensajes:

- `GET /api/chats/:chatId/messages`
- `POST /api/chats/:chatId/messages`

Mantener ese camino como principal.

`src/factures/mensajeria/services/mediaService.ts` contiene rutas antiguas:

- `GET /whatsapp/messages/:chatId`
- `POST /whatsapp/send-message`
- `POST /mark-read/:chatId`

Estas deben quedar deprecadas o mapearse al contrato nuevo:

- `GET /api/chats/:chatId/messages`
- `POST /api/chats/:chatId/messages`
- `PUT /api/chats/:chatId/read`

## Eventos Socket.IO

El frontend no debe cambiar su modelo mental de eventos. El backend debe traducir eventos de Meta a los mismos eventos actuales:

- `message`: mensaje entrante o saliente normalizado.
- `chats-updated`: lista/orden de conversaciones desde BD.
- `ready`: canal disponible.
- `disconnected`: canal no configurado, token invalido o proveedor no disponible.
- `state_changed`: cambios administrativos del canal.

Mensaje normalizado esperado:

```ts
type MessageInfo = {
  id: string;
  body: string;
  fromMe: boolean;
  timestamp: number;
  sender: string;
  type: 'text' | 'image' | 'audio' | 'video' | 'document' | 'template' | 'unknown';
  mediaUrl?: string | null;
  mimetype?: string | null;
  filename?: string | null;
  chatId: string;
};
```

Para Meta, `chatId` debe ser telefono/`wa_id` normalizado. Evitar crear nuevos IDs con sufijo `@c.us`.

## Criterios de aceptacion para Implementacion 1

- El frontend compila sin necesitar token de Meta.
- La pantalla de configuracion soporta proveedor `meta-cloud` sin mostrar QR.
- `GET /api/whatsapp/status` se interpreta correctamente para WebJS y Meta.
- La mensajeria usa `GET /api/chats/:chatId/messages` y `POST /api/chats/:chatId/messages`.
- No queda ningun token real en `localStorage`, `.env` del frontend o archivos versionados.
- Si el backend emite `message` por Socket.IO desde un webhook de Meta, la bandeja lo renderiza sin cambios grandes.

## Referencias

- Meta WhatsApp Cloud API: https://developers.facebook.com/docs/whatsapp/cloud-api
- Meta Cloud API Webhooks: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks
- Documentacion backend relacionada: `C:\whatsap\WhatsaapWeb-JS\docs\implementacion1\README.md`.
