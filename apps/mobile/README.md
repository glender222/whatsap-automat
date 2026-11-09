# Whatsap Automat móvil

Cliente Expo para consultar la bandeja de WhatsApp, responder con texto durante la ventana de atención y tomar una conversación cuando el servidor ofrece control de concurrencia.

## Desarrollo

Usa Node.js 22 y un servidor de Whatsap Automat accesible desde el dispositivo.

```bash
npm ci
npm run typecheck
npm test
npm start
```

Ingresa la dirección del servidor y una cuenta de operador existente. La app acepta el dominio, opcionalmente con `/api` o `/api/v1`. Puedes precargar el dominio con `EXPO_PUBLIC_API_URL`. Para Android Emulator, un backend local puede exponerse como `http://10.0.2.2:3000` en modo desarrollo. Los binarios de producción requieren HTTPS.

```bash
npm run android
npm run ios
npm run web
npx expo export --platform all
```

Las credenciales nativas se guardan en Expo SecureStore. La vista web conserva la sesión en memoria hasta que se recarga la página. El historial se actualiza al volver a la app y cada 15 segundos mientras la pantalla está activa.

## Distribución

Una exportación de Expo verifica los paquetes JavaScript para Android, iOS y web. Los instaladores nativos requieren un proyecto de compilación configurado, credenciales de firma y validación en un dispositivo.
