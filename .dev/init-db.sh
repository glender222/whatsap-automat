#!/usr/bin/env bash
set -euo pipefail

psql --username "$POSTGRES_USER" --dbname postgres --set=ON_ERROR_STOP=1 \
  --set=runtime_password="$APP_DB_PASSWORD" <<'SQL'
CREATE ROLE whatsap_dev LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'runtime_password';
CREATE DATABASE whatsap_dev_demo OWNER whatsap_dev;
SQL
