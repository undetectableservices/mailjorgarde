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
--   * the roles and ownership prerequisites for GoTrue's own migrations
--
-- GoTrue creates and owns auth.uid(), auth.role(), auth.email(), and auth.jwt().
-- Application schema installation waits until all GoTrue migrations finish.
-- ---------------------------------------------------------------------

\ir reconcile-auth.sql
