-- ---------------------------------------------------------------------
-- JorgardeMail — self-hosted backend bootstrap.
--
-- Runs ONCE, at database initialisation, before GoTrue or PostgREST
-- start. It recreates the minimal parts of the Supabase platform that
-- the application depends on:
--
--   * the anon / authenticated / service_role roles
--   * the `authenticator` login role PostgREST switches from
--   * the `auth` schema owned by GoTrue's admin role
--   * the auth.uid() / auth.role() / auth.jwt() helpers used by RLS
--
-- Everything is idempotent so it is safe to re-run by hand.
-- ---------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -------- Roles ------------------------------------------------------
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
END $$;

-- PostgREST connects as `authenticator` and SET ROLEs to one of the above.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    EXECUTE format(
      'CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD %L',
      'bootstrap-placeholder'
    );
  END IF;
END $$;

GRANT anon, authenticated, service_role TO authenticator;

-- GoTrue owns the `auth` schema.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    EXECUTE format(
      'CREATE ROLE supabase_auth_admin LOGIN NOINHERIT CREATEROLE PASSWORD %L',
      'bootstrap-placeholder'
    );
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin;
GRANT ALL ON SCHEMA auth TO supabase_auth_admin;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role, postgres;

-- The signup trigger lives in `public` and fires as supabase_auth_admin.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role, supabase_auth_admin;

-- -------- RLS helpers ------------------------------------------------
-- PostgREST puts the verified JWT claims in the `request.jwt.claims` GUC.

CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS jsonb
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), ''),
    '{}'
  )::jsonb
$$;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(auth.jwt() ->> 'sub', '')::uuid
$$;

CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(auth.jwt() ->> 'role', '')
$$;

CREATE OR REPLACE FUNCTION auth.email()
RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(auth.jwt() ->> 'email', '')
$$;

ALTER FUNCTION auth.jwt()   OWNER TO postgres;
ALTER FUNCTION auth.uid()   OWNER TO postgres;
ALTER FUNCTION auth.role()  OWNER TO postgres;
ALTER FUNCTION auth.email() OWNER TO postgres;

GRANT EXECUTE ON FUNCTION auth.jwt(), auth.uid(), auth.role(), auth.email()
  TO anon, authenticated, service_role, supabase_auth_admin;
