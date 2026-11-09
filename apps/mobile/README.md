# Whatsap Automat móvil

Cliente Expo para consultar la bandeja de WhatsApp, responder con texto durante la ventana de atención, tomar una conversación y revisar aprobaciones del espacio de trabajo.

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

Cuando caduca el token de acceso, el cliente agrupa las renovaciones concurrentes y verifica la cuenta y el espacio de trabajo antes de repetir cada operación una sola vez. Si la renovación falla de forma temporal, la sesión sigue abierta. Cuando el servidor revoca la renovación o el usuario cierra sesión, se requiere iniciar sesión de nuevo.

Para responder, el operador toma el control de la conversación y el servidor comprueba la versión y la ventana de atención. Si la entrega queda sin confirmar, el cliente pausa los envíos nuevos y permite reintentar la misma solicitud con su clave original mientras la sesión permanece abierta. El historial del servidor distingue los mensajes aceptados, fallidos y sin confirmar.

La bandeja muestra **Aprobaciones** cuando el servidor concede `approvals.review`. Una decisión ordinaria requiere confirmación y usa la versión de la solicitud y una clave que se conserva durante la sesión para reintentar la misma decisión. Las solicitudes de riesgo alto, financiero, irreversible o sin verificar permanecen visibles con la decisión bloqueada hasta contar con los controles de verificación correspondientes.

En WhatsApp Cloud, la conversación permite seleccionar cada adjunto disponible. El cliente descarga bajo demanda hasta 10 MiB desde el servidor autenticado. La vista previa de imágenes usa memoria. **Descargar archivo** guarda una copia en el navegador o en la carpeta elegida mediante el selector nativo. La aplicación no crea archivos temporales para este recorrido. Queda pendiente probar la vista previa y el selector en Android e iOS físicos.

## Distribución

Una exportación de Expo verifica los paquetes JavaScript para Android, iOS y web. Los instaladores nativos requieren un proyecto de compilación configurado, credenciales de firma y validación en un dispositivo.

Para generar un proyecto Android de desarrollo y compilarlo, usa Java 17, Android SDK Platform 37.0 y el NDK 27.1.12297006. Ejecuta `npx expo run:android` con un emulador o un dispositivo conectado. Los proyectos Android e iOS se regeneran a partir de la configuración de Expo.

### APK Android ARM64 para QA

Usa Linux con Node.js 22.13 o posterior dentro de la serie 22, JDK 17 y `ANDROID_HOME` apuntando a un SDK con Platform 37.0, Build Tools 37.0.0, NDK 27.1.12297006 y CMake 3.22.1. Ejecuta desde la raíz del repositorio. `QA_GIT_REF` selecciona el commit y `QA_APK_DIR` permite elegir una carpeta de salida absoluta.

`EXPO_PUBLIC_API_URL` queda visible dentro del APK. Usa únicamente el origen HTTPS de un servidor de pruebas. El valor predeterminado `https://127.0.0.1:3000` apunta al propio dispositivo y el operador puede cambiarlo al iniciar sesión.

```bash
set -euo pipefail
qa_ref="${QA_GIT_REF:-HEAD}"
qa_commit="$(git rev-parse --short "$qa_ref")"
qa_tree="$(mktemp -d)"
qa_output="${QA_APK_DIR:-$qa_tree}"
git archive "$qa_ref" apps/mobile | tar -x --strip-components=2 -C "$qa_tree"
cd "$qa_tree"
npm ci

export EXPO_PUBLIC_API_URL="${EXPO_PUBLIC_API_URL:-https://127.0.0.1:3000}"
export NODE_ENV=production EXPO_NO_DOTENV=1 EXPO_NO_TELEMETRY=1
node - <<'NODE'
const url = new URL(process.env.EXPO_PUBLIC_API_URL);
if (url.protocol !== 'https:' || url.username || url.password ||
    url.pathname !== '/' || url.search || url.hash) {
  throw new Error('EXPO_PUBLIC_API_URL debe ser un origen HTTPS de QA sin credenciales.');
}
NODE
npx --no-install expo prebuild --platform android --no-install

node - <<'NODE'
const fs = require('node:fs');
function replace(path, before, after) {
  const source = fs.readFileSync(path, 'utf8');
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) {
    throw new Error(`Revisa la plantilla Expo generada en ${path}`);
  }
  fs.writeFileSync(path, source.replace(before, after));
}

const gradle = 'android/app/build.gradle';
const release = fs.readFileSync(gradle, 'utf8').split('        release {')[1];
if (!release?.split('\n        }')[0].includes('signingConfig signingConfigs.debug')) {
  throw new Error('La variante release de QA requiere la firma de depuración de la plantilla.');
}
replace(gradle, '        release {', [
  '        release {',
  '            applicationIdSuffix ".qa"',
  '            versionNameSuffix "-qa"',
].join('\n'));
const manifest = 'android/app/src/main/AndroidManifest.xml';
replace(manifest, '<application android:name=', '<application android:usesCleartextTraffic="false" android:name=');
replace(manifest, 'android:scheme="whatsap-automat"', 'android:scheme="whatsap-automat-qa"');
replace('android/app/src/main/res/values/strings.xml', 'Whatsap-Automat Mobile', 'Whatsap Automat QA');
NODE

(cd android && ./gradlew --no-daemon --max-workers=2 -PreactNativeArchitectures=arm64-v8a \
  :app:createBundleReleaseJsAndAssets --rerun :app:assembleRelease)
qa_version="$(node -p 'require("./package.json").version')"
qa_apk="$qa_output/whatsap-automat-${qa_version}-qa-arm64-${qa_commit}.apk"
mkdir -p "$qa_output"
cp android/app/build/outputs/apk/release/app-release.apk "$qa_apk"

qa_tools="$ANDROID_HOME/build-tools/37.0.0"
"$qa_tools/apksigner" verify --print-certs "$qa_apk"
"$qa_tools/aapt" dump badging "$qa_apk" | sed -n '/^package:/p; /^application-label:/p; /^native-code:/p'
jar tf "$qa_apk" | grep -Fx 'assets/index.android.bundle'
sha256sum "$qa_apk"
```

El APK usa el paquete `com.whatsapautomat.mobile.qa`, la firma de depuración y JavaScript Hermes incluido. Se abre de forma autónoma sin Metro. Es una compilación de pruebas y requiere validación en un dispositivo ARM64 antes de dar por probado el recorrido nativo.
