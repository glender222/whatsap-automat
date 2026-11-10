# Admisión de proveedor IA por empresa

La migración 060 añade la política y los permisos activos del proveedor anterior. Ambas tablas aplican RLS. El gateway, el runtime de WhatsApp, las ejecuciones manuales y las pruebas del proveedor anterior registran un permiso antes de iniciar una operación. El permiso se elimina cuando la operación termina. El estado de una empresa nunca habilita las operaciones de otra.

| Estado | Admisión |
| --- | --- |
| `legacy` | Perfil anterior. Las empresas sin política explícita empiezan aquí. |
| `draining` | Se rechazan operaciones nuevas. Las que ya obtuvieron permiso pueden finalizar. |
| `strict` | Texto acotado con reserva de cuota. Requiere credencial OpenAI activa y cifrada de la empresa, sin URL personalizada. |
| `paused` | Se rechazan operaciones nuevas. Los consumos admitidos pueden liquidarse. |

El cambio de modo y el permiso del proveedor anterior toman el mismo bloqueo de PostgreSQL. Si el proceso muere antes de liberar el permiso, cambiar a `strict` requiere reconciliar ese registro. El gateway no cambia de proveedor si falla la política, falta una clave o se agota el presupuesto. La reserva y su permiso vuelven a comprobar el modo en la base. Para probar la conexión o guardar una clave se necesita el rol de administrador.

La política puede ejercitarse con `TenantAiDispatchPolicy.transition` desde la prueba de integración. El despliegue no cambia automáticamente el modo de ninguna empresa. Antes de un piloto real, hay que actualizar todas las réplicas y los consumidores, verificar el consumo previo y resolver cualquier permiso que siga abierto. La pausa puede volver a `strict`. El retorno al proveedor anterior después de usar el modo acotado requiere una decisión de migración de cuotas.

El modo `strict` bloquea el runtime anterior de respuestas de WhatsApp y las ejecuciones de agentes que dependan de él. Limitar el piloto a una empresa de prueba dedicada hasta que el runtime con herramientas use la misma admisión y se verifique su continuidad operativa.

En Agent Studio, una empresa en modo `strict` puede guardar su credencial desde «Credencial de OpenAI» dentro de «Evaluación y publicación». La clave se envía únicamente al backend y el campo se vacía tras guardar. «Credencial guardada» confirma el almacenamiento. La evaluación confirma si el proveedor devuelve una respuesta y un consumo válidos. Las evaluaciones, publicaciones y reintentos de texto acotado pertenecen al modo `provider` de esa empresa. En pausa, se conservan la revisión activa y la consulta o cancelación de evaluaciones. Las solicitudes nuevas de evaluación, publicación y ejecución reciben un error de disponibilidad.

Desde «Nuevo grafo», «Usar plantilla de texto» carga la topología y el modelo de texto actuales con un presupuesto de revisión para dos casos. El presupuesto contempla la reserva máxima de contexto antes de cada solicitud. El consumo se liquida con los valores devueltos por el proveedor. Cargar la plantilla y guardar el borrador no llama al modelo.

Para reproducir, aplicar las migraciones en PostgreSQL de prueba con un rol sin bypass de RLS. Exportar `AI_QUOTA_RESERVATIONS_TEST_DATABASE_URL` y ejecutar desde `WhatsaapWeb-JS`:

```sh
node --import tsx --test src/test/bounded-agent-dispatch.test.ts
```

El transporte de prueba apunta a HTTP local y comprueba el destino, la credencial de cada empresa, el número de solicitudes y la liquidación. No requiere una cuenta del proveedor.

Para el recorrido de navegador, usar la misma configuración sintética de MSG-01. Exportar `STUDIO_PROVIDER_FIXTURE=1`, `STUDIO_FIXTURE_URL=http://127.0.0.1:34257` y las variables del backend local. Iniciar `node --import tsx src/test/fixtures/browserStudio.ts` desde `WhatsaapWeb-JS`. Desde el frontend, ejecutar `npm run test:e2e -- e2e/agent-studio.integration.spec.ts -g 'provider mode'` con las mismas variables. El fixture inicia la composición predeterminada de la aplicación y redirige al proveedor local únicamente el destino exacto y la clave sintética de la prueba.
