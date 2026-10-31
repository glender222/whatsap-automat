# PR-07: Spike de Temporal OSS, Workers TypeScript y Orquestación Duradera

## 1. Resumen Ejecutivo

Este directorio contiene la implementación aislada de **PR-07** conforme al **Blueprint v0.4** (§7 y §14) y la **Guía de Sesiones** de Whatsap-Automat. 

El objetivo primordial ha sido validar empíricamente y sin tocar código productivo ni tráfico real de WhatsApp:
1. El despliegue de **Temporal OSS** con persistencia en **PostgreSQL segregado**.
2. La implementación de **Workers TypeScript** con el SDK oficial `@temporalio/*` (v1.25.0).
3. La ejecución de pruebas automatizadas de:
   - **Durabilidad y recuperación ante muerte abrupta y reinicio de trabajadores.**
   - **Temporizadores duraderos (Timers) sin consumo de hilos ni memoria activa.**
   - **Políticas de reintento exponencial y manejo de errores transitorios vs permanentes.**
   - **Replay de historial de eventos para certificar 100% de determinismo.**
4. La medición de **consumo de recursos (RAM/CPU)** para despejar el riesgo arquitectónico sobre la viabilidad de autoalojamiento (self-host).

---

## 2. Consumo Real de Recursos Medido

Mediciones obtenidas en el entorno de pruebas Linux x86_64 (12 vCPUs, 16 GiB RAM) con el cluster Docker Compose y los Workers en ejecución:

| Servicio / Proceso | Rol | Memoria RAM (RSS) | CPU en Reposo | CPU en Carga |
|---|---|---|---|---|
| `demo-temporal-postgresql` | Persistencia (`temporal` + `temporal_visibility`) | 122.4 MiB | 0.11% | 2.5% |
| `demo-temporal-server` | Cluster Temporal OSS (Frontend, History, Matching, Worker) | 83.3 MiB | 0.20% | 9.4% |
| `demo-temporal-ui` | Interfaz Web de Operaciones (Puerto 8233 -> 8080) | 6.9 MiB | 0.00% | 0.1% |
| `demo-temporal-admin-tools` | Utilidades CLI de diagnóstico y healthcheck | 87.4 MiB | 0.00% | 0.0% |
| `demo-temporal-spike-worker` | Contenedor Worker TypeScript (Node.js 22-slim) | ~110 MiB | 0.10% | 8.0% |
| `worker.ts` (Proceso Host) | Worker TypeScript nativo con sandbox V8 y Rust bridge | ~260 MiB | 0.20% | 11.8% |

### Conclusión de Infraestructura:
El stack base de **Temporal OSS + PostgreSQL dedicado ocupa únicamente ~212 MiB de RAM** en reposo/carga moderada. Un nodo VPS de 1 GiB a 2 GiB de RAM es perfectamente capaz de soportar la infraestructura de Temporal OSS para pequeñas y medianas empresas.

---

## 3. Comandos Reproducibles

### 3.1 Prerrequisitos
- Node.js >= 20 (recomendado v22+)
- Docker & Docker Compose v2+

### 3.2 Levantar el Stack de Demostración Temporal OSS
Desde la raíz del repositorio:
```bash
# Levantar PostgreSQL segregado, Servidor Temporal y Web UI
docker compose -f compose.demo.yaml up -d

# Verificar estado y health checks
docker compose -f compose.demo.yaml ps

# Comprobar salud del cluster gRPC
docker exec demo-temporal-admin-tools temporal operator cluster health
# Salida esperada: SERVING

# Acceder a la Web UI en el navegador:
# http://localhost:8233
```

### 3.3 Ejecución de Pruebas Automatizadas del Spike
Desde la subcarpeta `spikes/temporal`:
```bash
cd spikes/temporal
npm install

# Compilar y verificar tipado TypeScript estricto
npm run typecheck
npm run build

# Ejecutar toda la suite de pruebas automatizadas (4 suites, 5 tests)
npm test

# Ejecutar el runner con reporte consolidado y tiempos
npm run test:runner
```

### 3.4 Ejecutar las Pruebas Individuales
```bash
# 1. Prueba de durabilidad y recuperación tras muerte del worker
npm run test:durability

# 2. Prueba de reintentos exponenciales y fallos transitorios
npm run test:retries

# 3. Prueba de temporizadores duraderos con time-skipping
npm run test:timer

# 4. Prueba de replay de eventos y determinismo
npm run test:replay
```

### 3.5 Ejecutar Worker y Cliente en Modo Manual / Interactivo
```bash
# Terminal 1: Iniciar Worker conectado al stack Docker
npm run start:worker

# Terminal 2: Disparar flujos de prueba con el cliente
npm run start:client all
# O por tipo:
npm run start:client durability
npm run start:client approval
npm run start:client retry
npm run start:client timer
```

### 3.6 Desmantelamiento (Teardown)
```bash
# Detener contenedores y eliminar volúmenes efímeros
docker compose -f compose.demo.yaml down -v
```

---

## 4. Pruebas Ejecutadas y Resultados

Todas las pruebas fueron ejecutadas con el test runner nativo de Node.js (`node --test`) y TypeScript vía `tsx`.

| Suite | Archivo | Casos Verificados | Resultado | Duración |
|---|---|---|---|---|
| **Temporizadores** | `src/tests/timer.test.ts` | Temporizador duradero (60s) con avance instantáneo de tiempo (Time Skipping) y consulta de estado | **PASSED** (1/1) | ~2.8s |
| **Reintentos** | `src/tests/retry-backoff.test.ts` | 1. Recuperación automática tras 3 fallos transitorios con backoff exponencial.<br>2. Fallo inmediato (fail-fast) ante error permanente sin reintentos ciegos | **PASSED** (2/2) | ~4.1s |
| **Replay & Determinismo** | `src/tests/replay.test.ts` | Ejecución de workflow, extracción de 40 eventos del historial, y replay contra la definición en V8 sin violaciones de determinismo | **PASSED** (1/1) | ~3.2s |
| **Durabilidad & Caída de Worker** | `src/tests/durability.test.ts` | Workflow iniciado en Worker 1 -> Worker 1 muere abruptamente (0 workers activos) -> Workflow permanece RUNNING en Temporal -> Worker 2 inicia en la cola -> Recupera ejecución y completa efecto de negocio con effectKey | **PASSED** (1/1) | ~5.3s |
| **Caída de Contenedor Docker** | Validación en Docker Compose | Contenedor de Worker detenido (`docker stop`) en mitad del workflow con timer activo -> Verificado RUNNING en Temporal Server -> Contenedor reactivado (`docker start`) -> Workflow completado con éxito | **PASSED** | ~6.5s |

---

## 5. Decisiones de Diseño y Cumplimiento del Blueprint v0.4

1. **Principio de Determinismo (§7.1):**
   - El código del workflow es 100% determinista: no invoca directamente `Math.random()`, APIs de red ni bases de datos. Toda la E/S reside en Actividades protegidas con timeouts y retry policies.
2. **Actividades Idempotentes (§7.3):**
   - La actividad `executeBusinessEffect` valida una clave de idempotencia compuesta (`effectKey:effect:tenant:eventRef`). Al repetirse la ejecución, retorna el efecto cacheado sin duplicar mutaciones de negocio.
3. **Referencias Cortas en Historial (§7.2):**
   - Solo se registran identificadores (`tenantId`, `eventRef`, `effectKey`). Ningún token de proveedor, mensaje raw ni PII sensible entra al historial de eventos de Temporal.
4. **Segregación de Base de Datos (§7.2 y §15.2):**
   - Se aprovisionaron bases de datos separadas (`temporal` y `temporal_visibility`) en un contenedor PostgreSQL aislado (`demo-temporal-postgresql`) en el puerto 5435 para evitar colisiones con el PostgreSQL de negocio (puerto 5432/5433).

---

## 6. Limitaciones Identificadas en el Spike

1. **Cache de Idempotencia en Memoria:**
   - La actividad del spike almacena las `effectKey` en un `Map` en memoria local. En **PR-08**, este almacenamiento debe estar respaldado por la tabla transaccional de negocio con RLS (`processing_outbox` / `business_effects`) en PostgreSQL.
2. **Ambiente Alpine Linux vs Addon Nativo:**
   - El puente nativo Rust de `@temporalio/core-bridge` está compilado contra `glibc`. Por ello, la imagen Docker del worker se estandarizó en `node:22-slim` (Debian) en lugar de `alpine` para garantizar compatibilidad binaria absoluta sin requerir capas de emulación `musl`.
3. **Aislamiento de Multi-Tenancy:**
   - En este spike, `tenantId` se valida como parámetro de contexto en cada actividad. Temporal Namespaces proporcionan aislamiento a nivel de entorno (`staging`, `prod`), pero el aislamiento por tenant en la capa de datos requiere revalidación en las actividades contra la base de negocio con RLS (PR-03 / PR-08).

---

## 7. Decisiones Técnicas Pendientes para PR-08

1. **Mecanismo de Despacho desde Outbox:**
   - *Opción A:* Polling con `SELECT ... FOR UPDATE SKIP LOCKED` cada 500ms en el relay de outbox.
   - *Opción B:* `LISTEN / NOTIFY` de PostgreSQL complementado con un reconciliador periódico (sweep de 30s) para mitigar conexiones caídas.
2. **Esquema Normalizado de Workflow ID:**
   - Definir formalmente: `workflowId = inbound:{connectionId}:{providerEventId}` (o hash seguro SHA-256 de los identificadores del proveedor para evitar superar límites de longitud de clave en Temporal).
3. **Estrategia de Compensación:**
   - En flujos donde un efecto externo (ej. envío a Meta Graph API) falle con código ambiguo (408 o 504), definir la actividad de consulta de estado del proveedor antes de reintentar el despacho o marcar `unknown_delivery`.
