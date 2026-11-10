# Plan de validación y entrega de Whatsap-Automat

La rama de trabajo es `integration/v0.4-consolidated`. El objetivo es verificar los recorridos completos que se ofrecen a operadores, administradores y desarrolladores. El estado de cada función se determina en el commit candidato a release, con una instalación limpia, servicios reales donde corresponda y evidencia de los resultados.

## Equipo y responsabilidades

| Rol | Responsabilidad | Entrega |
| --- | --- | --- |
| Orquestación y release | Ordenar dependencias, resolver cruces entre áreas, integrar cambios y coordinar publicación | Candidato identificable por SHA, CI, notas, artefactos y rollback |
| Lead de producto web y diseño | Unificar navegación, estados, accesibilidad y recorridos de operador y administrador | Diseño revisable y pruebas de escritorio, móvil y teclado |
| Lead móvil | Validar sesión, bandeja, mensajería, recuperación y empaquetado de Expo | Pruebas del cliente, bundles y verificación en dispositivos según plataforma |
| Lead de plataforma y seguridad | Validar DB, auth, Socket.IO, API, adaptadores, Temporal y límites de los agentes | Instalación limpia y regresiones positivas y adversariales |
| Lead de documentación y distribución | Mantener instalación, API, SDK, descargas y estado de capacidades | Portal verificable, artefactos versionados y guía de actualización |
| QA independiente | Reproducir el resultado con el SHA del candidato y revisar los flujos críticos | Dictamen por recorrido con comandos, evidencia, fallos y decisión |

Los agentes trabajan en worktrees separados y entregan cambios acotados. QA rota entre agentes que no hayan implementado el cambio correspondiente. Cada entrega registra alcance, archivos, migraciones, compatibilidad, comandos, resultado exacto y rollback. Los hallazgos críticos pasan a la primera posición de la cola de integración.

## Secuencia de entrega

1. **Instalación reproducible.** Compilar contratos antes de sus consumidores, instalar con archivos de bloqueo, migrar una base vacía y una base previa, y arrancar con un rol de ejecución sin `BYPASSRLS`. Confirmar CI del backend y los contratos en Node.js 20 y 22. La web requiere Node.js 22 por el visor de PDF.
2. **Operación principal.** Registrar dos empresas, iniciar sesión, operar la bandeja, leer mensajes y tomar control de una conversación. Validar persistencia real, permisos, errores de red y aislamiento en HTTP, PostgreSQL y Socket.IO. Las respuestas y las aprobaciones deben conservar consistencia ante reintentos.
3. **Producto web y móvil.** Recorrer las mismas funciones desde sus entradas normales. Verificar navegación, estados vacíos, carga, reconexión, sesión vencida, acciones bloqueadas y accesibilidad. Revisar los recorridos con capturas y evidencia de interacción. Empaquetar Android e iOS y distinguir exportación de JavaScript, build instalable y prueba en dispositivo.
4. **Automatización y ecosistema.** Probar publicación, ejecución, reanudación y auditoría de flujos con Temporal. Verificar permisos y presupuesto en agentes, consentimientos y entrega en campañas, conexión de canales, SDK, CLI y extensiones. Validar dependencias externas en entornos autorizados. Las funciones incompletas permanecen desactivadas o claramente identificadas como experimentales.
5. **Distribución.** Reconstruir el candidato, ejecutar los controles de seguridad y restauración, probar descargas desde la documentación y publicar únicamente artefactos comprobados. Integrar a `main` después de la revisión independiente y con la estrategia de rollback de la release registrada.

## Matriz de aceptación

| Área | Evidencia requerida para ofrecerla |
| --- | --- |
| Sesión y empresas | Registro, login, renovación, cierre de sesión y roles. Dos empresas quedan aisladas incluso con IDs o claims manipulados. |
| Inbox y tiempo real | Mensaje entrante firmado, deduplicación, historial, adjuntos, estados y takeover. Un segundo intento con versión obsoleta devuelve conflicto. Solo la empresa destinataria recibe eventos. |
| Canales y conexiones | Conectar, diagnosticar, revocar y enviar usando credenciales de prueba. Un canal desconocido o sin permisos falla sin generar efectos en otra empresa. |
| Workflows y Temporal | Disparar desde la API, observar el consumo por un worker y recuperar tras reinicio. El replay conserva la versión y no duplica efectos. |
| Agentes y herramientas | Validar, simular, publicar y ejecutar un grafo. Rechazar roles inyectados, accesos no autorizados y acciones fuera de presupuesto. |
| Aprobaciones | Aprobar y rechazar con roles autorizados, expiración y control de concurrencia. La ejecución revalida la decisión antes del efecto externo. |
| Campañas y consentimiento | Segmentación con datos reales, exclusión de revocados, controles de ritmo y entrega registrada. Un fallo de DB impide despachar con consentimiento incierto. |
| Operación y SRE | Salud real, auditoría, rotación de secretos y restauración ensayada. Diagnósticos sin datos inventados ni secretos en logs. |
| SDK, CLI y extensiones | Instalar desde el artefacto, ejecutar un ejemplo sobre la API y verificar contratos, permisos y checksum. Las mutaciones del catálogo exigen identidad y autorización. |
| Web, móvil y documentación | Revisar los recorridos anteriores desde interfaces reales. Probar teclado, navegación estrecha, recuperación de sesión y descargas con sus permisos efectivos. |

## Evidencia de integración local

| Recorrido | Evidencia | Pendiente para la release |
| --- | --- | --- |
| Instalación, sesión y bandeja | Backend compilado sobre 53 migraciones y PostgreSQL sin `BYPASSRLS`. RLS aísla las sesiones. Los tokens de acceso nuevos están vinculados a su sesión. Se comprobó que el logout en una réplica cierra Socket.IO en otra y que un JWT revocado recibe 401 en HTTP y Socket.IO. La expiración, la pérdida de la conexión de escucha, el webhook firmado, la paginación v1 y la toma de control se probaron con procesos reales. Graph local recuperó envíos inciertos de texto y adjuntos. | Desplegar las migraciones 051 y 052 de forma coordinada. Los JWT anteriores sin vínculo expiran según el plazo original. Validar con una cuenta autorizada de WhatsApp. |
| Operación web | Chromium en escritorio y pantalla estrecha. Registro, inicio de sesión, canales, envío idempotente de texto y adjuntos, confirmación de campañas, Marketplace, consola de workflows, simulación en Agent Studio y visor PDF autenticado. El navegador recupera un envío incierto fuera de los 50 mensajes recientes. Las pruebas Socket.IO locales cubren renovar en la misma sesión, volver a la sala activa y descartar callbacks tras cambiar de cuenta. | Revisión independiente del candidato completo y recuperación de contraseña con correo real. |
| Operación móvil | Expo 58, exportaciones Android, iOS y web. Chromium verificó envío idempotente de texto y adjuntos, renovación de sesión, descarga protegida, avisos internos y reautenticación. Tras perder un acuse, la app consulta el estado. El APK de QA ARM64 de `ce3f696` incluye estos flujos con firma de depuración, manifiesto no depurable, Hermes, alineación de 16 KiB y checksum verificados. | Validar el candidato en dispositivo ARM64, compilar iOS de forma nativa y completar APNs/FCM. |
| Workflows | PostgreSQL, consola web y worker Temporal locales. Revisiones fijadas, duplicados concurrentes, rollback y recuperación tras pérdida del acuse comprobados. Relay y worker probados con certificados de cliente. Temporal 1.32.2 recuperó tres ejecuciones y sus 104 eventos en otro PostgreSQL. La demo en Docker completó un temporizador con namespace y cola personalizados. | Ensayar el procedimiento con la configuración del servicio de producción. |
| Agentes y aprobaciones | Studio compara revisiones y diagnostica su compatibilidad con el perfil lineal. El despacho interno y el gateway estricto de prueba compartieron cuota en PostgreSQL. Verificaron la cota antes de la llamada, el permiso de un solo uso y la liquidación. Las solicitudes compatibles siguen disponibles si caben en el saldo tras una retención incierta. Las aprobaciones sensibles requieren contraseña actual y membresía. | Habilitar la política por empresa y coordinar los llamadores que usan `AiProviderFactory`. Ajustar la cota de entrada, validar el proveedor y vincular la evidencia de publicación a una revisión ejecutada. Verificar pertenencia de los adjuntos de conocimiento históricos. |
| Campañas | Graph local y estado real en PostgreSQL. Se comprobó consentimiento, ventana, revisión de audiencia y acuse. Al matar el proceso durante el envío, la campaña se pausa cuando vence su permiso de despacho. Conserva el intento incierto hasta recibir un webhook firmado. Una revisión nueva permite enviar solo a los destinatarios restantes. | Validar envío autorizado y conciliar intentos históricos sin referencia. Las campañas que quedaron en despacho antes de la migración 046 requieren revisión operativa. |
| Marketplace | Publicación, puntuaciones y reseñas comprobadas con RLS. El propietario puede retirar fichas. El CLI verifica offline firmas y comprueba manifiesto, rutas, expansión y puntos de entrada sobre los mismos bytes firmados. El empaquetador conserva rutas USTAR representables y rechaza enlaces simbólicos. Sus pruebas pasan en Node.js 20 y 22. | Integrar la inspección en staging, aplicar permisos de instalación y comprobar el aislamiento del ejecutor. |
| Catálogo, inventario y pedidos | Roles, rollback, imágenes principales concurrentes y stock con operador registrado. En Chromium a 390 px, el operador reservó con plazo y el detalle mostró la liberación automática. PostgreSQL comprobó que la expiración devuelve stock una sola vez. Un comprobante validado tras el vencimiento aparece en Pagos para conciliación manual. | Medir el barrido de vencimientos con la carga y los volúmenes de producción. |
| Comprobantes, historial y reportes | Aprobación y reserva en una transacción. CSV y Excel incluyen todas las filas coincidentes. PDF y CSV conservan sus bytes tras renovar una sesión vencida. La API descarga el adjunto exacto con la credencial de la línea original. PostgreSQL aplica el aislamiento de adjuntos a las lecturas y escrituras directas. FFmpeg y Graph local verificaron la transcodificación, el límite de video y la limpieza de temporales. | Validar adjuntos con proveedor autorizado y probar la vista previa y descarga en un dispositivo real. |
| Pasarelas | Configuración cifrada por empresa. Las intenciones internas de Mercado Pago usan RLS, calculan el total PEN desde el pedido y conservan una única intención por orden. PostgreSQL comprobó reintentos concurrentes y anulación al validar un comprobante. El adaptador aislado de Mercado Pago Orders se probó por HTTP local con importes exactos, expiración, acuses inciertos y conciliación de estados. | Validar la cuenta peruana autorizada, persistir el despacho y conciliar pagos antes de habilitar el checkout público. |
| Documentación y release | El repositorio contiene el portal, la guía y los contratos. Se verificaron los ZIP y sus sumas. Los SDK instalados desde el kit registraron dos decisiones sensibles sobre Express y PostgreSQL. La CLI empaquetó y verificó extensiones de prueba. El SBOM CycloneDX se reproduce desde seis archivos de bloqueo. | Distribuir la documentación mediante GitHub Actions y los instaladores verificados mediante GitHub Releases. GitHub exige el permiso `workflow` para aceptar los cambios de CI. El escaneo estricto aún informa tres advertencias de Lightning CSS en las herramientas de compilación móvil. |

El archivo de QA `whatsap-automat-0.4.0-qa-arm64-ce3f696.apk` tiene 34 736 496 bytes y SHA-256 `20aed867bede1618b8413eb252ed355655012f52dd1dbe41124d3cbc97775050`. Se empaquetó sin R8 ni reducción de recursos para QA. Los APK anteriores se conservaron.

## Criterio de refactor y retirada

- **Corregir** una función alcanzable desde la aplicación o requerida para un recorrido. Primero reproducir el defecto y conservar los contratos que usen clientes existentes.
- **Desactivar** la acción cuando falten persistencia, permisos, proveedor o ejecución real. Mostrar un estado explícito y dejar un camino comprobable para rehabilitarla.
- **Retirar** prototipos, duplicados o dependencias después de verificar referencias, rutas, consumidores externos y compatibilidad. Actualizar documentación y pruebas en el mismo cambio.
- **Validar** cada recorrido con datos reales de prueba y distinguir pruebas unitarias, integración con servicios, pruebas de interfaz y ejecución contra proveedores. Una simulación se presenta como tal.

## Condiciones de integración y comunicación

El candidato se compara con `main` y se revisa como conjunto. Debe pasar CI, los recorridos críticos y la auditoría de permisos y datos. Un fallo crítico de seguridad, pérdida de datos, instalación, arranque o regresión bloquea la integración. Las limitaciones externas se registran junto con la capacidad afectada y el alcance exacto que se distribuye.

Se comunica cada resultado significativo con área, SHA o evidencia y consecuencia para la entrega. Las referencias de diseño, criterios de QA y fases funcionales se mantienen en sus documentos canónicos. [Blueprint v0.4](../architecture/BLUEPRINT_v0.4.md) · [Roadmap v1.0](../architecture/ROADMAP_V1.0.md) · [Criterios de QA](../qa/QA_GATES_AND_CASES.md)
