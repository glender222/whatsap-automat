# APK Android de QA del candidato 6fd05ca

El APK se construyó desde `6fd05caa5e9d5f2305505300afdbfeee9c492ac0`, con el árbol móvil `960c3b8b409a013c8003a3325fb6e42e136d2650`. Incluye el tratamiento de aprobaciones históricas duplicadas de ese candidato.

| Dato | Resultado verificado |
| --- | --- |
| Archivo | `whatsap-automat-0.4.0-qa-arm64-6fd05ca.apk` |
| Tamaño | 34 738 220 bytes |
| SHA-256 | `acba42c27052f644d42bd96f4ca105eaf3e43d72faf14fc9ae5692cfda5b855e` |
| Paquete | `com.whatsapautomat.mobile.qa` |
| Versión | `0.4.0-qa`, código 1 |
| Arquitectura | `arm64-v8a` |
| Firma | Android Debug, esquema v2 |
| Certificado SHA-256 | `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c` |
| Manifiesto | `debuggable=false`, `usesCleartextTraffic=false`, SDK mínimo 24 y objetivo 36 |
| JavaScript | Bundle Hermes incluido, con `APPROVAL_EFFECT_CONFLICT` |
| Alineación | `zipalign -P 16` correcto y las 22 bibliotecas ELF con segmentos LOAD de al menos 16 KiB |
| Origen API incluido | `https://127.0.0.1:3000`, editable al iniciar sesión |

Se usaron Node.js 22, JDK 17, Build Tools 37.0.0, Platform 37.0, NDK 27.1.12297006 y CMake 3.22.1. El empaquetado siguió la [guía móvil](../../apps/mobile/README.md#apk-android-arm64-para-qa), eligiendo explícitamente `android.enableMinifyInReleaseBuilds=false` y `android.enableShrinkResourcesInReleaseBuilds=false` para acotar recursos de QA. La primera ejecución con R8 se detuvo voluntariamente durante la compilación. El segundo empaquetado terminó correctamente y produjo el archivo descrito.

Pasaron el typecheck y las 42 pruebas del cliente móvil. La compilación del APK y la inspección estática verifican el paquete instalable. La prueba de sus recorridos en un dispositivo ARM64 queda pendiente.

Se instaló el emulador oficial 37.2.13 con una imagen Android 34 x86_64 y se creó un AVD exclusivo. El host Azure x86_64 tiene 4 CPU y 15 GiB de RAM, carece de `/dev/kvm` y de flags `vmx`/`svm`. El comprobador oficial informó que KVM necesita esos flags. Se intentó arrancar con `-accel off`, renderizado SwiftShader y Gradle detenido. El kernel avanzó en el inicio y ADB permaneció `offline` hasta detener el AVD al acotar la entrega de esta primera versión. La validación de la aplicación nativa queda pendiente. La compilación nativa de iOS requiere un entorno con Xcode.

La carpeta `qa-artifacts` del workspace conserva el APK, `whatsap-automat-0.4.0-qa-arm64-6fd05ca.apk.sha256` y `whatsap-automat-0.4.0-qa-arm64-6fd05ca.metadata.json`. Los binarios de QA anteriores se conservaron.
