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
| Instalación, sesión y bandeja | Backend compilado arrancado con una base PostgreSQL vacía y rol sin `BYPASSRLS`. Webhook firmado, historial, paginación v1, Socket.IO por empresa y toma de control comprobados. | Validar proveedor de prueba y recuperación de envíos inciertos. |
| Operación web | Chromium en escritorio y pantalla estrecha. Bandeja con envío idempotente, confirmación de campañas, Marketplace, consola de workflows, edición de revisiones en Agent Studio y visor PDF autenticado con datos de prueba. | Revisión independiente de todos los recorridos del candidato. |
| Operación móvil | Expo 58, exportación Android, iOS y web. Envío idempotente probado en Chromium. APK de QA ARM64 compilado en `6c52180` con Hermes integrado y firma de depuración verificada. | Prueba en dispositivo ARM64 y compilación nativa de iOS. |
| Workflows | PostgreSQL, consola web y worker Temporal locales. Revisiones fijadas, duplicados concurrentes, rollback y recuperación tras pérdida del acuse comprobados. Relay y worker probados con certificados de cliente. | Validar el servicio de producción y su procedimiento de recuperación. |
| Agentes y aprobaciones | Revisiones de Studio inmutables, trazas por empresa, pausa de IA y auditoría de decisiones verificadas con PostgreSQL. Simulación acotada con aserciones y sin efectos externos. | Evaluación de publicación vinculada a la revisión ejecutada y validación del proveedor de IA. |
| Campañas | Graph simulado y estado real en PostgreSQL. Se comprobó consentimiento, ventana de servicio, revisión de audiencia y acuse del proveedor. | Envío de prueba autorizado y soporte operativo para entrega incierta. |
| Marketplace | Publicación por API, puntuaciones agregadas y edición de reseña comprobadas con RLS. | Instalación de extensiones y gestión de publicaciones desde la interfaz. |
| Catálogo, inventario y pedidos | Roles, rollback, imágenes principales concurrentes y stock con operador registrado. QA web de inventario a 390 px. Reserva, cancelación y consumo del pedido probados con PostgreSQL. | QA web del ciclo de pedidos y operación del vencimiento de reservas. |
| Comprobantes, historial y reportes | Archivo protegido y apertura autenticada comprobada en Chromium. Aprobación y reserva en una transacción. Historial con adjuntos y reportes filtrados con descargas CSV y Excel. | QA web de reportes y prueba con proveedor autorizado para adjuntos remotos. |
| Pasarelas | Configuración cifrada por empresa y verificación de que un webhook repetido no produce efectos. | Intenciones de cobro y conciliación con proveedor. |
| Documentación y release | Portal local y paquete de guías y contratos descargables verificados. | Publicar el portal y artefactos validados. GitHub exige el permiso `workflow` para aceptar los cambios de CI. |

## Criterio de refactor y retirada

- **Corregir** una función alcanzable desde la aplicación o requerida para un recorrido. Primero reproducir el defecto y conservar los contratos que usen clientes existentes.
- **Desactivar** la acción cuando falten persistencia, permisos, proveedor o ejecución real. Mostrar un estado explícito y dejar un camino comprobable para rehabilitarla.
- **Retirar** prototipos, duplicados o dependencias después de verificar referencias, rutas, consumidores externos y compatibilidad. Actualizar documentación y pruebas en el mismo cambio.
- **Validar** cada recorrido con datos reales de prueba y distinguir pruebas unitarias, integración con servicios, pruebas de interfaz y ejecución contra proveedores. Una simulación se presenta como tal.

## Condiciones de integración y comunicación

El candidato se compara con `main` y se revisa como conjunto. Debe pasar CI, los recorridos críticos y la auditoría de permisos y datos. Un fallo crítico de seguridad, pérdida de datos, instalación, arranque o regresión bloquea la integración. Las limitaciones externas se registran junto con la capacidad afectada y el alcance exacto que se distribuye.

Se comunica cada resultado significativo con área, SHA o evidencia y consecuencia para la entrega. Las referencias de diseño, criterios de QA y fases funcionales se mantienen en sus documentos canónicos. [Blueprint v0.4](../architecture/BLUEPRINT_v0.4.md) · [Roadmap v1.0](../architecture/ROADMAP_V1.0.md) · [Criterios de QA](../qa/QA_GATES_AND_CASES.md)
