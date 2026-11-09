# Guía de Despliegue de Temporal OSS y Hardening para Producción

Este documento detalla la arquitectura de despliegue, configuración de seguridad, TLS/mTLS, persistencia segregada y recomendaciones de recursos para **Temporal OSS** en Whatsap-Automat, conforme a las especificaciones del **Blueprint v0.4** (§7 y §15) y los requerimientos de **PR-07**.

## Entorno local con Compose

Desde este directorio, copia `.env.example` a `.env` y configura las credenciales de PostgreSQL de la demo. Los puertos publicados quedan en `127.0.0.1` y el volumen `temporal-postgres-data` conserva ambas bases de Temporal. El servicio de esquema termina antes de arrancar Temporal Server y la UI espera al namespace.

```sh
docker compose up -d
docker compose ps -a
temporal operator namespace describe --address 127.0.0.1:7233 --namespace default
```

La UI abre en `http://127.0.0.1:8233`. Las imágenes de Temporal están fijadas a sus versiones y sumas de imagen. El servicio de esquema descarga el código fuente de esa versión y comprueba su SHA-256 antes de aplicar las migraciones de PostgreSQL. Para actualizar un volumen existente, detén el entorno anterior y respalda ambas bases antes del arranque. [Ejemplo oficial de Temporal con PostgreSQL](https://github.com/temporalio/samples-server/blob/main/compose/docker-compose-postgres.yml)

El archivo `compose.demo.yaml` de la raíz reutiliza estos servicios y conserva el volumen de la demo. El perfil `worker` añade el ejemplo de Temporal y arranca cuando el namespace está listo. Esa entrada requiere Docker Compose 2.20 o posterior. [Inclusión de archivos Compose](https://docs.docker.com/reference/compose-file/include/)

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
Configura estas variables en el servidor `temporalio/server` y monta los archivos de certificados en las rutas indicadas.

```yaml
environment:
  # Habilitación de TLS
  TEMPORAL_TLS_FRONTEND_CERT: /etc/temporal/certs/cluster.cert
  TEMPORAL_TLS_FRONTEND_KEY: /etc/temporal/certs/cluster.key
  TEMPORAL_TLS_CLIENT1_CA_CERT: /etc/temporal/certs/ca.cert
  TEMPORAL_TLS_REQUIRE_CLIENT_AUTH: "true"

  # TLS entre servicios internos del cluster (History, Matching)
  TEMPORAL_TLS_SERVER_CERT: /etc/temporal/certs/cluster.cert
  TEMPORAL_TLS_SERVER_KEY: /etc/temporal/certs/cluster.key
  TEMPORAL_TLS_SERVER_CA_CERT: /etc/temporal/certs/ca.cert
  TEMPORAL_TLS_FRONTEND_SERVER_NAME: temporal.internal
  TEMPORAL_TLS_INTERNODE_SERVER_NAME: temporal.internal
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
- **Entorno de prueba**. `TEMPORAL_NAMESPACE_RETENTION=3d` al crear el namespace en Compose.
- **Entorno productivo**. Configura la retención de cada namespace según el periodo de auditoría y la capacidad de almacenamiento.
- Pasado este periodo, Temporal purga automáticamente las ejecuciones cerradas para evitar el crecimiento desmedido de PostgreSQL.

### 3.2 Archival para Auditoría de Largo Plazo
Si necesitas conservar el historial más allá de la retención del namespace, configura el bloque `archival` del servidor y el destino de historial o visibilidad del namespace. Comprueba que el servicio pueda escribir y consultar el destino antes de reducir la retención en PostgreSQL. [Configuración oficial de Archival](https://docs.temporal.io/self-hosted-guide/archival)

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

Detén el ingreso de nuevas ejecuciones, el relay y los workers. En la demo, detén Temporal y su UI para tomar las dos copias del mismo punto de corte.

```sh
docker compose stop temporal-ui temporal
umask 077
docker compose exec -T temporal-postgresql sh -c \
  'pg_dump --format=custom --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"' > temporal.dump
docker compose exec -T temporal-postgresql sh -c \
  'pg_dump --format=custom --username "$POSTGRES_USER" --dbname "$VISIBILITY_DBNAME"' > temporal-visibility.dump
sha256sum temporal.dump temporal-visibility.dump > temporal.sha256
```

Restaura ambas copias en un servidor PostgreSQL separado con bases vacías, los nombres de base originales y sus propietarios. Temporal identifica cada versión de esquema por nombre de base. Las entradas en `pg_service.conf` deben apuntar al servidor de restauración. Confirma las sumas antes de iniciar la restauración.

```sh
sha256sum -c temporal.sha256
pg_restore --exit-on-error --single-transaction --dbname=service=temporal-restore temporal.dump
pg_restore --exit-on-error --single-transaction --dbname=service=temporal-visibility-restore temporal-visibility.dump
```

Arranca Temporal con las bases restauradas y verifica namespace, historial y visibilidad antes de conectar workers. Compara las ejecuciones con el outbox y el estado de negocio del mismo punto de corte. Conserva el identificador original de cada ejecución y sus claves de efectos al reconciliar. [Respaldo de la base de negocio](../../WhatsaapWeb-JS/README.md#respaldar-y-restaurar-la-base-de-negocio)
