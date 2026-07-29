#!/bin/sh
# Runs during Postgres initialisation and again as the pre-auth reconciliation
# job. Creates the Supabase-compatible roles/schema, then sets their real
# passwords from the environment (never baked into a SQL file).
set -eu

bootstrap_sql="${1:-/selfhost/db/bootstrap.sql}"
case "$bootstrap_sql" in
  /selfhost/db/*.sql) ;;
  *)
    echo "[bootstrap] refusing SQL outside /selfhost/db" >&2
    exit 1
    ;;
esac
[ -f "$bootstrap_sql" ] || {
  echo "[bootstrap] missing SQL file: $bootstrap_sql" >&2
  exit 1
}

run_psql() {
  if [ -n "${POSTGRES_HOST:-}" ]; then
    PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required for remote bootstrap}" \
      psql -v ON_ERROR_STOP=1 \
        --host "$POSTGRES_HOST" \
        --port "${POSTGRES_PORT:-5432}" \
        --username "$POSTGRES_USER" \
        --dbname "$POSTGRES_DB" \
        "$@"
  else
    psql -v ON_ERROR_STOP=1 \
      --username "$POSTGRES_USER" \
      --dbname "$POSTGRES_DB" \
      "$@"
  fi
}

wait_for_postgres() {
  [ -n "${POSTGRES_HOST:-}" ] || return 0

  attempt=1
  while ! pg_isready \
    --host "$POSTGRES_HOST" \
    --port "${POSTGRES_PORT:-5432}" \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" >/dev/null 2>&1; do
    if [ "$attempt" -ge 30 ]; then
      echo "[bootstrap] PostgreSQL did not accept TCP connections after 60 seconds" >&2
      exit 1
    fi
    attempt=$((attempt + 1))
    sleep 2
  done
}

wait_for_postgres
run_psql -f "$bootstrap_sql"

run_psql \
  --set=authpw="$AUTHENTICATOR_PASSWORD" \
  --set=adminpw="$AUTH_ADMIN_PASSWORD" <<'SQL'
BEGIN;
ALTER ROLE authenticator       WITH LOGIN NOINHERIT PASSWORD :'authpw';
ALTER ROLE supabase_auth_admin WITH LOGIN NOINHERIT CREATEROLE PASSWORD :'adminpw';
COMMIT;
SQL

echo "[bootstrap] roles, auth schema, and helper ownership are ready"
