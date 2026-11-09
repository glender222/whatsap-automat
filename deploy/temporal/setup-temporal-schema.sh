#!/bin/sh
set -eu

export SQL_PASSWORD="${POSTGRES_PWD:?}"
endpoint=${POSTGRES_SEEDS:?}
user=${POSTGRES_USER:?}
port=${DB_PORT:-5432}
schema_root=${TEMPORAL_SCHEMA_DIR:-}
scratch=$(mktemp -d)
trap 'rm -r -- "$scratch"' EXIT

if [ -z "$schema_root" ]; then
  source_archive="$scratch/temporal.tar.gz"
  wget -q -O "$source_archive" https://codeload.github.com/temporalio/temporal/tar.gz/refs/tags/v1.32.2
  printf '%s  %s\n' f56f8c4e2ea10e50cfddc8d66bbba54fcff4f157ae3dfcefc179acfc5de0315c "$source_archive" | sha256sum -c -
  tar -xzf "$source_archive" -C "$scratch" temporal-1.32.2/schema/postgresql/v12
  schema_root="$scratch/temporal-1.32.2/schema/postgresql/v12"
fi

upgrade_schema() {
  database=$1
  schema=$2
  set -- temporal-sql-tool --plugin postgres12 --ep "$endpoint" -u "$user" -p "$port" --db "$database"
  if "$@" update-schema -d "$schema_root/$schema/versioned" > "$scratch/update.log" 2>&1; then
    cat "$scratch/update.log"
    return
  fi

  # setup-schema rewrites the current version. Only run it on a fresh database.
  if ! grep -Eq 'error reading current schema version:pq: relation .*schema_version.* does not exist.*[(]42P01[)]' "$scratch/update.log"; then
    cat "$scratch/update.log" >&2
    return 1
  fi

  "$@" setup-schema -v 0.0
  "$@" update-schema -d "$schema_root/$schema/versioned"
}

upgrade_schema "${DBNAME:-temporal}" temporal
upgrade_schema "${VISIBILITY_DBNAME:-temporal_visibility}" visibility
