#!/usr/bin/env bash
set -e

# Este script se ejecuta en /docker-entrypoint-initdb.d/ de PostgreSQL
# Asegura la existencia de las bases de datos requeridas por Temporal OSS:
# 1. temporal (almacén por defecto de ejecuciones, tareas e historial)
# 2. temporal_visibility (almacén de visibilidad para búsquedas y UI)

echo "==> Inicializando bases de datos segregadas para Temporal OSS..."

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=visibility="${VISIBILITY_DBNAME:-temporal_visibility}" --set=owner="$POSTGRES_USER" <<'EOSQL'
    SELECT format('CREATE DATABASE %I OWNER %I', :'visibility', :'owner')
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'visibility')\gexec
EOSQL

echo "==> Bases de datos de Temporal (temporal y temporal_visibility) listas."
