# Whatsap Automat móvil

Cliente Expo para consultar la bandeja de WhatsApp, responder con texto durante la ventana de atención y tomar una conversación cuando el servidor ofrece control de concurrencia.

## Desarrollo

Usa Node.js 22.13 o posterior dentro de la serie 22, y un servidor de Whatsap Automat accesible desde el dispositivo. La aplicación usa Expo SDK 58.

```bash
npm ci
npx expo-doctor
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

Para responder, el operador toma el control de la conversación y el servidor comprueba la versión y la ventana de atención. Si la entrega queda sin confirmar, el cliente pausa los envíos nuevos y permite reintentar la misma solicitud con su clave original mientras la sesión permanece abierta. El historial del servidor distingue los mensajes aceptados, fallidos y sin confirmar.

## Distribución

Una exportación de Expo verifica los paquetes JavaScript para Android, iOS y web. Los instaladores nativos requieren un proyecto de compilación configurado, credenciales de firma y validación en un dispositivo.

Para generar un proyecto Android de desarrollo y compilarlo, usa Java 17, Android SDK Platform 37.0 y el NDK 27.1.12297006. Ejecuta `npx expo run:android` con un emulador o un dispositivo conectado. Los proyectos Android e iOS se regeneran a partir de la configuración de Expo.
