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

COMMIT;
