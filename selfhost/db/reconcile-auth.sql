-- ---------------------------------------------------------------------
-- Idempotent pre-GoTrue role and ownership reconciliation.
--
-- This file is safe to run before every Auth start. It deliberately does
-- not CREATE OR REPLACE GoTrue-managed helper functions: once GoTrue has
-- migrated them, their definitions must remain under its control.
-- ---------------------------------------------------------------------

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD 'bootstrap-placeholder';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    CREATE ROLE supabase_auth_admin LOGIN NOINHERIT CREATEROLE
      PASSWORD 'bootstrap-placeholder';
  END IF;
END $$;

ALTER ROLE anon NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS;
ALTER ROLE authenticated NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS;
ALTER ROLE service_role NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION BYPASSRLS;
ALTER ROLE authenticator LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS;
ALTER ROLE supabase_auth_admin LOGIN NOINHERIT NOSUPERUSER NOCREATEDB CREATEROLE
  NOREPLICATION NOBYPASSRLS;

GRANT anon, authenticated, service_role TO authenticator;

CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin;
ALTER SCHEMA auth OWNER TO supabase_auth_admin;
GRANT ALL ON SCHEMA auth TO supabase_auth_admin;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role, postgres;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role, supabase_auth_admin;
ALTER ROLE supabase_auth_admin SET search_path TO 'auth';

DO $$
BEGIN
  EXECUTE format(
    'GRANT CREATE ON DATABASE %I TO supabase_auth_admin',
    current_database()
  );
END $$;

-- The original bootstrap shipped helper bodies before GoTrue's first
-- migration and owned them as postgres. If migration 00 has not committed,
-- remove only those four helpers and let GoTrue create its canonical versions.
-- DROP is intentionally not CASCADE: unexpected dependencies stop recovery
-- instead of deleting application objects.
DO $$
DECLARE
  initial_migration_applied boolean := false;
BEGIN
  IF to_regclass('auth.schema_migrations') IS NOT NULL THEN
    EXECUTE
      'SELECT EXISTS (SELECT 1 FROM auth.schema_migrations WHERE version = ''00'')'
      INTO initial_migration_applied;
  END IF;

  IF NOT initial_migration_applied THEN
    RAISE NOTICE 'Auth migration 00 is not applied; removing legacy bootstrap helpers';
    EXECUTE 'DROP FUNCTION IF EXISTS auth.uid()';
    EXECUTE 'DROP FUNCTION IF EXISTS auth.role()';
    EXECUTE 'DROP FUNCTION IF EXISTS auth.email()';
    EXECUTE 'DROP FUNCTION IF EXISTS auth.jwt()';
  END IF;
END $$;

-- Repair objects left by an interrupted/older bootstrap, while preserving
-- the function bodies installed by GoTrue migrations.
DO $$
DECLARE
  helper_name text;
BEGIN
  FOR helper_name IN
    SELECT p.proname
      FROM pg_proc AS p
      JOIN pg_namespace AS n ON n.oid = p.pronamespace
     WHERE n.nspname = 'auth'
       AND p.pronargs = 0
       AND p.prokind = 'f'
       AND p.proname = ANY (ARRAY['jwt', 'uid', 'role', 'email'])
  LOOP
    EXECUTE format(
      'ALTER FUNCTION auth.%I() OWNER TO supabase_auth_admin',
      helper_name
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION auth.%I() TO anon, authenticated, service_role, supabase_auth_admin',
      helper_name
    );
  END LOOP;
END $$;

DO $$
DECLARE
  wrong_owners text;
BEGIN
  IF (SELECT nspowner FROM pg_namespace WHERE nspname = 'auth')
       IS DISTINCT FROM 'supabase_auth_admin'::regrole THEN
    RAISE EXCEPTION 'supabase_auth_admin does not own the auth schema';
  END IF;

  SELECT string_agg(format('auth.%I()', p.proname), ', ' ORDER BY p.proname)
    INTO wrong_owners
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
   WHERE n.nspname = 'auth'
     AND p.pronargs = 0
     AND p.prokind = 'f'
     AND p.proname = ANY (ARRAY['jwt', 'uid', 'role', 'email'])
     AND p.proowner <> 'supabase_auth_admin'::regrole;

  IF wrong_owners IS NOT NULL THEN
    RAISE EXCEPTION 'GoTrue helper ownership repair failed: %', wrong_owners;
  END IF;
END $$;

COMMIT;
