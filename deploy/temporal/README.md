# Guía de Despliegue de Temporal OSS y Hardening para Producción

Este documento detalla la arquitectura de despliegue, configuración de seguridad, TLS/mTLS, persistencia segregada y recomendaciones de recursos para **Temporal OSS** en Whatsap-Automat, conforme a las especificaciones del **Blueprint v0.4** (§7 y §15) y los requerimientos de **PR-07**.

---

## 1. Arquitectura de Despliegue

```text
                  +----------------------------------------------+
                  |               Red Privada / VPC              |
                  |                                              |
 [Reverse Proxy]  |   +------------------+   +---------------+   |
 (Nginx / Caddy) ---> |   Temporal Web   |   | Temporal CLI  |   |
  Puerto 443/TLS  |   |     (UI:8080)    |   | (admin-tools) |   |
                  |   +--------+---------+   +-------+-------+   |
                  |            |                     |           |
                  |            v                     v           |
                  |   +--------------------------------------+   |
                  |   |    Temporal Server (gRPC: 7233)      |   |
                  |   | Frontend / History / Matching / Sys  |   |
                  |   +------------------+-------------------+   |
                  |                      |                       |
                  |     mTLS interno     v   Conexión SQL        |
                  |   +------------------+-------------------+   |
                  |   |  Workers Dedicados | Postgres Segregado|  |
                  |   |   (TypeScript)     | temporal & visib|   |
                  |   +--------------------+-----------------+   |
                  +----------------------------------------------+
```

### 1.1 Segregación Estricta de Persistencia (Innegociable)
Conforme a la regla de diseño del Blueprint v0.4:
- **Base de datos de Negocio (PostgreSQL con RLS):** Contiene `conversations`, `messages`, `tenants`, `inbox`, `outbox`, `agent_runs`. Manejada con migraciones de aplicación.
- **Base de datos de Temporal (PostgreSQL dedicado):** Contiene los esquemas `temporal` (estado de ejecución interna, shards de historial, tareas) y `temporal_visibility` (índices de búsqueda para la UI y CLI).
- **Justificación:** Los ciclos de migración, retención, replicación, backup (PITR) y carga de I/O de Temporal son radicalmente distintos a los de la lógica transaccional de mensajería. Nunca mezclar los esquemas en la misma instancia sin aislamiento de recursos y usuarios.

---

## 2. Configuración de TLS y mTLS para Producción

En producción, el puerto gRPC `7233` no debe exponer texto plano ni estar abierto a Internet público. Se debe implementar **mTLS (Mutual TLS)** para autenticar tanto al servidor como a los clientes/workers.

### 2.1 Requisitos de Certificados
Se requieren pares de certificados X.509 firmados por una Autoridad Certificadora (CA) interna o corporativa:
1. `ca.cert`: Certificado raíz de la CA.
2. `cluster.cert` y `cluster.key`: Certificado y clave privada del servidor Temporal (Frontend e inter-nodo).
3. `client.cert` y `client.key`: Certificado y clave privada para Workers y Clientes de la API.

### 2.2 Variables de Entorno del Servidor Temporal
Para habilitar TLS en `temporalio/auto-setup` o `temporalio/server`:

```yaml
environment:
  # Habilitación de TLS
  TEMPORAL_TLS_CERTS_DIR: /etc/temporal/certs
  TEMPORAL_TLS_FRONTEND_CERT: /etc/temporal/certs/cluster.cert
  TEMPORAL_TLS_FRONTEND_KEY: /etc/temporal/certs/cluster.key
  TEMPORAL_TLS_CLIENT_CA_CERT: /etc/temporal/certs/ca.cert
  TEMPORAL_TLS_REQUIRE_CLIENT_AUTH: "true"

  # TLS entre servicios internos del cluster (History, Matching)
  TEMPORAL_TLS_INTERNODE_CERT: /etc/temporal/certs/cluster.cert
  TEMPORAL_TLS_INTERNODE_KEY: /etc/temporal/certs/cluster.key
  TEMPORAL_TLS_SERVER_CA_CERT: /etc/temporal/certs/ca.cert
```

### 2.3 Worker de automatizaciones con mTLS

Ejecuta el worker compilado de `WhatsaapWeb-JS` con la misma configuración de PostgreSQL que el backend. El proceso ejecuta el relay del outbox y el worker. Monta los certificados como archivos de solo lectura.

```sh
TEMPORAL_ADDRESS=temporal.internal:7233 \
TEMPORAL_NAMESPACE=default \
TEMPORAL_TLS=true \
TEMPORAL_TLS_CA_FILE=/certs/ca.cert \
TEMPORAL_TLS_CERT_FILE=/certs/client.cert \
TEMPORAL_TLS_KEY_FILE=/certs/client.key \
node dist/services/temporal/automationWorker.js
```

Usa `TEMPORAL_TLS_SERVER_NAME` si el nombre del certificado difiere del nombre de conexión por un proxy. El proceso exige ambos archivos del certificado de cliente cuando se configura mTLS. Si se configura `TEMPORAL_TLS=true` con una CA pública, los archivos son opcionales.

---

## 3. Retención de Historial y Archival

### 3.1 Política de Retención (`Retention Period`)
- **Entorno Demo / Pruebas:** `DEFAULT_NAMESPACE_RETENTION=3d` (3 días).
- **Entorno Productivo:** Se recomienda entre 7 y 30 días (`DEFAULT_NAMESPACE_RETENTION=14d`).
- Pasado este periodo, Temporal purga automáticamente las ejecuciones cerradas para evitar el crecimiento desmedido de PostgreSQL.

### 3.2 Archival para Auditoría de Largo Plazo
Si una empresa requiere conservar el historial de flujos de trabajo por motivos regulatorios (e.g. 1 a 5 años):
- Activar **Archival** hacia almacenamiento de objetos S3 / Google Cloud Storage / Azure Blob / MinIO local.
- Temporal descarga el historial completo de eventos en formato JSON comprimido hacia el bucket configurado antes de purgarlo de PostgreSQL.

```yaml
environment:
  ARCHIVAL_ENABLED: "true"
  ARCHIVAL_PROVIDER: "s3" # o gcs
  ARCHIVAL_HISTORY_S3_BUCKET_NAME: "whatsap-temporal-history-archive"
  ARCHIVAL_VISIBILITY_S3_BUCKET_NAME: "whatsap-temporal-visibility-archive"
```

---

## 4. Dimensionamiento y Consumo de Recursos

Basado en las mediciones empíricas realizadas en el spike (PR-07):

| Componente | Perfil Demo / Minimal | Perfil Producción Recomendado (100k msg/día) |
|---|---|---|
| **Temporal Server** | 100 MiB RAM, 0.2 CPU | 2-4 GiB RAM, 1-2 vCPU |
| **Temporal UI** | 10 MiB RAM, 0.05 CPU | 128 MiB RAM, 0.2 vCPU |
| **PostgreSQL Temporal** | 150 MiB RAM, 0.2 CPU | 4-8 GiB RAM, 2 vCPU (con SSD NVMe) |
| **TypeScript Worker** | 250 MiB RAM, 0.2 CPU | 1-2 GiB RAM, 1-2 vCPU (escalable horizontalmente) |
| **Total Stack Mínimo** | **~510 MiB RAM, 0.65 CPU** | **8-16 GiB RAM, 4-6 vCPU** |

> [!NOTE]
> Temporal OSS es extremadamente ligero en reposo (< 300 MiB de RAM para el cluster completo + PostgreSQL). Esto confirma la viabilidad de autoalojamiento en VPS modestos ($10-$20/mes) para pequeñas y medianas empresas.

---

## 5. Pruebas de Salud y Monitoreo

### 5.1 Endpoint de Métricas Prometheus
Temporal Server expone métricas Prometheus en el puerto configurado (típicamente `9090` o a través del dev-server en `40737`):
- `temporal_workflow_success_count`: Tasa de workflows completados.
- `temporal_workflow_failed_count`: Tasa de fallos en ejecución.
- `temporal_activity_execution_latency`: Latencia de ejecución por actividad.
- `temporal_schedule_to_start_latency`: Tiempo que una tarea espera en cola antes de que un worker la recoja (indicador clave para escalar workers horizontalmente).

### 5.2 Health Checks de Contenedor
- **Temporal Server:**
  ```bash
  temporal operator cluster health --address 127.0.0.1:7233
  ```
  Debe retornar `SERVING`.
- **PostgreSQL:**
  ```bash
  pg_isready -U temporal -d temporal
  ```
- **Web UI:**
  ```bash
  nc -z 127.0.0.1 8080 || exit 1
  ```

---

## 6. Procedimientos de Respaldo y Restauración (OPS-01)

1. **Backup de Esquemas Temporal:**
   ```bash
   docker exec -t demo-temporal-postgresql pg_dump -U temporal temporal > backup_temporal_$(date +%Y%m%d).sql
   docker exec -t demo-temporal-postgresql pg_dump -U temporal temporal_visibility > backup_visibility_$(date +%Y%m%d).sql
   ```
2. **Restauración:**
   ```bash
   cat backup_temporal.sql | docker exec -i demo-temporal-postgresql psql -U temporal -d temporal
   cat backup_visibility.sql | docker exec -i demo-temporal-postgresql psql -U temporal -d temporal_visibility
   ```
3. **Reconciliación:**
   Temporal retiene el estado de las tareas pendientes. Al restaurar, los trabajadores reconectan y reanudan las tareas registradas en el snapshot sin duplicación lógica si las actividades respetan sus `effectKey`.
