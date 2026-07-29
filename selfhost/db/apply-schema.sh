#!/bin/sh
# ---------------------------------------------------------------------
# Applies the JorgardeMail application schema to the self-hosted
# database. Runs as a one-shot container on every `up`, but only ever
# applies each file once. The ledger intentionally lives outside the
# PostgREST-exposed `public` schema so application users cannot tamper
# with upgrade state.
#
# It waits for GoTrue to finish its own migrations first, because the
# app schema has foreign keys onto auth.users.
# ---------------------------------------------------------------------
set -eu

export PGPASSWORD="$POSTGRES_PASSWORD"
PSQL="psql -v ON_ERROR_STOP=1 -h $POSTGRES_HOST -U $POSTGRES_USER -d $POSTGRES_DB -qtA"

echo "[schema] waiting for the database…"
i=0
until pg_isready -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 120 ] && { echo "[schema] database never came up"; exit 1; }
  sleep 2
done

echo "[schema] waiting for the auth service to create auth.users…"
i=0
until [ "$($PSQL -c "SELECT to_regclass('auth.users') IS NOT NULL")" = "t" ]; do
  i=$((i + 1)); [ "$i" -gt 120 ] && { echo "[schema] auth.users never appeared — is the auth container healthy?"; exit 1; }
  sleep 2
done

$PSQL -c "CREATE SCHEMA IF NOT EXISTS jorgarde_private AUTHORIZATION postgres;
          REVOKE ALL ON SCHEMA jorgarde_private FROM PUBLIC, anon, authenticated, service_role;
          CREATE TABLE IF NOT EXISTS jorgarde_private.schema_migrations (
            name TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          REVOKE ALL ON jorgarde_private.schema_migrations FROM PUBLIC, anon, authenticated, service_role;
          DO \$\$
          BEGIN
            IF to_regclass('public._schema_migrations') IS NOT NULL THEN
              -- The public ledger was writable by authenticated users in 001,
              -- so its rows are not evidence that a migration ran. Infer the
              -- atomic baseline only from its complete set of schema objects;
              -- never trust attacker-preseeded migration names.
              IF to_regclass('public.profiles') IS NOT NULL
                 AND to_regclass('public.mailboxes') IS NOT NULL
                 AND to_regclass('public.messages') IS NOT NULL
                 AND to_regclass('public.dms') IS NOT NULL
                 AND to_regclass('public.settings') IS NOT NULL THEN
                INSERT INTO jorgarde_private.schema_migrations (name, applied_at)
                SELECT '001_app_schema.sql', COALESCE(
                  (SELECT applied_at FROM public._schema_migrations
                   WHERE name = '001_app_schema.sql'),
                  now()
                )
                ON CONFLICT (name) DO NOTHING;
              END IF;
              DROP TABLE public._schema_migrations;
            END IF;
          END
          \$\$;" >/dev/null

for f in /selfhost/db/schema/*.sql; do
  [ -e "$f" ] || continue
  name="$(basename "$f")"
  applied="$($PSQL -c "SELECT 1 FROM jorgarde_private.schema_migrations WHERE name = '$name'")"
  if [ "$applied" = "1" ]; then
    echo "[schema] $name — already applied"
    continue
  fi
  echo "[schema] applying $name"
  # Apply the file and record it in one transaction. A crash can no longer
  # leave a successfully changed schema with a missing ledger entry.
  psql -v ON_ERROR_STOP=1 -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
       --single-transaction -f "$f" \
       -c "INSERT INTO jorgarde_private.schema_migrations (name) VALUES ('$name')" \
       >/dev/null
done

# The signup trigger runs as the GoTrue role, so it needs to be able to
# reach (but not read) the SECURITY DEFINER function in public.
$PSQL -c "GRANT USAGE ON SCHEMA public TO supabase_auth_admin;" >/dev/null
$PSQL -c "DO \$\$ BEGIN
            IF to_regprocedure('public.handle_new_user()') IS NOT NULL THEN
              GRANT EXECUTE ON FUNCTION public.handle_new_user() TO supabase_auth_admin;
            END IF;
          END \$\$;" >/dev/null

# New public tables are private by default. Every API-facing table must opt in
# explicitly in a reviewed migration, with RLS enabled before privileges are
# granted. UUID keys mean the current schema needs no application sequences.
$PSQL -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public
            REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
          ALTER DEFAULT PRIVILEGES IN SCHEMA public
            GRANT ALL ON TABLES TO service_role;
          ALTER DEFAULT PRIVILEGES IN SCHEMA public
            REVOKE ALL ON FUNCTIONS FROM PUBLIC;" >/dev/null

echo "[schema] done"
