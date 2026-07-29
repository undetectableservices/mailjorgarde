-- ---------------------------------------------------------------------
-- JorgardeMail — self-hosted backend bootstrap.
--
-- Runs once at fresh database initialisation. The recurring, non-destructive
-- subset lives in reconcile-auth.sql and runs before GoTrue on every deploy.
-- Together they create the minimal parts of the platform the app depends on:
--
--   * the anon / authenticated / service_role roles
--   * the `authenticator` login role PostgREST switches from
--   * the `auth` schema owned by GoTrue's admin role
--   * the auth.uid() / auth.role() / auth.jwt() helpers used by RLS
--
-- Do not rerun this full file after GoTrue has migrated; it intentionally
-- supplies initial helper bodies that GoTrue subsequently owns and updates.
-- ---------------------------------------------------------------------

\ir reconcile-auth.sql

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

-- GoTrue's own migrations CREATE OR REPLACE auth.uid() and auth.role().
-- Those migrations run as supabase_auth_admin, so that role must own the
-- helpers or a fresh installation fails with SQLSTATE 42501.
ALTER FUNCTION auth.jwt()   OWNER TO supabase_auth_admin;
ALTER FUNCTION auth.uid()   OWNER TO supabase_auth_admin;
ALTER FUNCTION auth.role()  OWNER TO supabase_auth_admin;
ALTER FUNCTION auth.email() OWNER TO supabase_auth_admin;

GRANT EXECUTE ON FUNCTION auth.jwt(), auth.uid(), auth.role(), auth.email()
  TO anon, authenticated, service_role, supabase_auth_admin;
