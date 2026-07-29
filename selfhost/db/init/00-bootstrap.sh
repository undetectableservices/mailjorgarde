#!/bin/sh
# Runs once, during Postgres initialisation, before anything else starts.
# Creates the Supabase-compatible roles/schema, then sets their real
# passwords from the environment (never baked into a SQL file).
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -f /selfhost/db/bootstrap.sql

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=authpw="$AUTHENTICATOR_PASSWORD" \
  --set=adminpw="$AUTH_ADMIN_PASSWORD" <<'SQL'
ALTER ROLE authenticator         WITH PASSWORD :'authpw';
ALTER ROLE supabase_auth_admin   WITH PASSWORD :'adminpw';
SQL

echo "[bootstrap] roles, auth schema and RLS helpers are ready"
