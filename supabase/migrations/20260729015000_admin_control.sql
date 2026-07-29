-- Runtime configuration controlled by the administration panel. Secrets are
-- encrypted by the web service with a dedicated key before reaching Postgres.
-- Only service_role may call the narrow subsystem-specific functions.

CREATE TABLE IF NOT EXISTS jorgarde_private.runtime_configuration (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  jellyfin_revision BIGINT NOT NULL DEFAULT 0 CHECK (jellyfin_revision >= 0),
  jellyfin_managed BOOLEAN NOT NULL DEFAULT FALSE,
  jellyfin_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  jellyfin_url TEXT,
  jellyfin_api_key_encrypted TEXT,
  jellyfin_updated_at TIMESTAMPTZ,
  smtp_revision BIGINT NOT NULL DEFAULT 0 CHECK (smtp_revision >= 0),
  smtp_managed BOOLEAN NOT NULL DEFAULT FALSE,
  smtp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  smtp_host TEXT,
  smtp_port INTEGER NOT NULL DEFAULT 587 CHECK (smtp_port BETWEEN 1 AND 65535),
  smtp_security TEXT NOT NULL DEFAULT 'starttls' CHECK (smtp_security IN ('starttls', 'tls')),
  smtp_username TEXT,
  smtp_password_encrypted TEXT,
  smtp_max_recipients INTEGER NOT NULL DEFAULT 25 CHECK (smtp_max_recipients BETWEEN 1 AND 50),
  smtp_updated_at TIMESTAMPTZ,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  CHECK (jellyfin_url IS NULL OR char_length(jellyfin_url) <= 2048),
  CHECK (jellyfin_api_key_encrypted IS NULL OR char_length(jellyfin_api_key_encrypted) <= 4096),
  CHECK (smtp_host IS NULL OR char_length(smtp_host) <= 253),
  CHECK (smtp_username IS NULL OR char_length(smtp_username) <= 512),
  CHECK (smtp_password_encrypted IS NULL OR char_length(smtp_password_encrypted) <= 8192)
);

CREATE TABLE IF NOT EXISTS jorgarde_private.runtime_configuration_audit (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subsystem TEXT NOT NULL CHECK (subsystem IN ('jellyfin', 'smtp')),
  revision BIGINT NOT NULL,
  managed BOOLEAN NOT NULL,
  enabled BOOLEAN NOT NULL,
  secret_rotated BOOLEAN NOT NULL DEFAULT FALSE,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  changed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

INSERT INTO jorgarde_private.runtime_configuration (singleton)
VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;

REVOKE ALL ON jorgarde_private.runtime_configuration,
  jorgarde_private.runtime_configuration_audit
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_jellyfin_runtime_configuration()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, jorgarde_private
AS $$
  SELECT jsonb_build_object(
    'revision', r.jellyfin_revision,
    'managed', r.jellyfin_managed,
    'enabled', r.jellyfin_enabled,
    'url', r.jellyfin_url,
    'api_key_encrypted', r.jellyfin_api_key_encrypted,
    'updated_at', r.jellyfin_updated_at
  )
  FROM jorgarde_private.runtime_configuration r
  WHERE r.singleton = TRUE;
$$;

CREATE OR REPLACE FUNCTION public.get_smtp_runtime_configuration()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, jorgarde_private
AS $$
  SELECT jsonb_build_object(
    'revision', r.smtp_revision,
    'managed', r.smtp_managed,
    'enabled', r.smtp_enabled,
    'host', r.smtp_host,
    'port', r.smtp_port,
    'security', r.smtp_security,
    'username', r.smtp_username,
    'password_encrypted', r.smtp_password_encrypted,
    'max_recipients', r.smtp_max_recipients,
    'updated_at', r.smtp_updated_at
  )
  FROM jorgarde_private.runtime_configuration r
  WHERE r.singleton = TRUE;
$$;

CREATE OR REPLACE FUNCTION public.set_jellyfin_runtime_configuration(
  p_expected_revision BIGINT,
  p_managed BOOLEAN,
  p_enabled BOOLEAN,
  p_url TEXT,
  p_api_key_encrypted TEXT,
  p_updated_by UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, jorgarde_private
AS $$
DECLARE
  next_revision BIGINT;
  secret_rotated BOOLEAN;
BEGIN
  IF p_updated_by IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = p_updated_by AND ur.role = 'admin'::public.app_role
  ) THEN
    RAISE EXCEPTION 'Administrator required' USING ERRCODE = '42501';
  END IF;
  IF p_expected_revision < 0
     OR char_length(COALESCE(p_url, '')) > 2048
     OR char_length(COALESCE(p_api_key_encrypted, '')) > 4096 THEN
    RAISE EXCEPTION 'Invalid Jellyfin configuration' USING ERRCODE = '22023';
  END IF;

  SELECT r.jellyfin_api_key_encrypted IS DISTINCT FROM NULLIF(p_api_key_encrypted, '')
  INTO secret_rotated
  FROM jorgarde_private.runtime_configuration r
  WHERE r.singleton = TRUE;

  UPDATE jorgarde_private.runtime_configuration r
  SET jellyfin_revision = r.jellyfin_revision + 1,
      jellyfin_managed = p_managed,
      jellyfin_enabled = p_enabled,
      jellyfin_url = NULLIF(p_url, ''),
      jellyfin_api_key_encrypted = NULLIF(p_api_key_encrypted, ''),
      jellyfin_updated_at = clock_timestamp(),
      updated_by = p_updated_by
  WHERE r.singleton = TRUE AND r.jellyfin_revision = p_expected_revision
  RETURNING r.jellyfin_revision INTO next_revision;

  IF next_revision IS NULL THEN
    RAISE EXCEPTION 'Configuration changed concurrently' USING ERRCODE = '40001';
  END IF;
  INSERT INTO jorgarde_private.runtime_configuration_audit (
    subsystem, revision, managed, enabled, secret_rotated, changed_by
  ) VALUES ('jellyfin', next_revision, p_managed, p_enabled, secret_rotated, p_updated_by);
  DELETE FROM jorgarde_private.runtime_configuration_audit
  WHERE changed_at < clock_timestamp() - INTERVAL '365 days';

  RETURN jsonb_build_object(
    'revision', next_revision,
    'managed', p_managed,
    'enabled', p_enabled,
    'url', NULLIF(p_url, ''),
    'api_key_set', NULLIF(p_api_key_encrypted, '') IS NOT NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_smtp_runtime_configuration(
  p_expected_revision BIGINT,
  p_managed BOOLEAN,
  p_enabled BOOLEAN,
  p_host TEXT,
  p_port INTEGER,
  p_security TEXT,
  p_username TEXT,
  p_password_encrypted TEXT,
  p_max_recipients INTEGER,
  p_updated_by UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, jorgarde_private
AS $$
DECLARE
  next_revision BIGINT;
  secret_rotated BOOLEAN;
BEGIN
  IF p_updated_by IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = p_updated_by AND ur.role = 'admin'::public.app_role
  ) THEN
    RAISE EXCEPTION 'Administrator required' USING ERRCODE = '42501';
  END IF;
  IF p_expected_revision < 0 OR p_port NOT BETWEEN 1 AND 65535
     OR p_security NOT IN ('starttls', 'tls') OR p_max_recipients NOT BETWEEN 1 AND 50
     OR char_length(COALESCE(p_host, '')) > 253
     OR char_length(COALESCE(p_username, '')) > 512
     OR char_length(COALESCE(p_password_encrypted, '')) > 8192 THEN
    RAISE EXCEPTION 'Invalid SMTP configuration' USING ERRCODE = '22023';
  END IF;

  SELECT r.smtp_password_encrypted IS DISTINCT FROM NULLIF(p_password_encrypted, '')
  INTO secret_rotated
  FROM jorgarde_private.runtime_configuration r
  WHERE r.singleton = TRUE;

  UPDATE jorgarde_private.runtime_configuration r
  SET smtp_revision = r.smtp_revision + 1,
      smtp_managed = p_managed,
      smtp_enabled = p_enabled,
      smtp_host = NULLIF(p_host, ''),
      smtp_port = p_port,
      smtp_security = p_security,
      smtp_username = NULLIF(p_username, ''),
      smtp_password_encrypted = NULLIF(p_password_encrypted, ''),
      smtp_max_recipients = p_max_recipients,
      smtp_updated_at = clock_timestamp(),
      updated_by = p_updated_by
  WHERE r.singleton = TRUE AND r.smtp_revision = p_expected_revision
  RETURNING r.smtp_revision INTO next_revision;

  IF next_revision IS NULL THEN
    RAISE EXCEPTION 'Configuration changed concurrently' USING ERRCODE = '40001';
  END IF;
  INSERT INTO jorgarde_private.runtime_configuration_audit (
    subsystem, revision, managed, enabled, secret_rotated, changed_by
  ) VALUES ('smtp', next_revision, p_managed, p_enabled, secret_rotated, p_updated_by);
  DELETE FROM jorgarde_private.runtime_configuration_audit
  WHERE changed_at < clock_timestamp() - INTERVAL '365 days';

  RETURN jsonb_build_object(
    'revision', next_revision,
    'managed', p_managed,
    'enabled', p_enabled,
    'host', NULLIF(p_host, ''),
    'port', p_port,
    'security', p_security,
    'username', NULLIF(p_username, ''),
    'password_set', NULLIF(p_password_encrypted, '') IS NOT NULL,
    'max_recipients', p_max_recipients
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_jellyfin_runtime_configuration(),
  public.get_smtp_runtime_configuration(),
  public.set_jellyfin_runtime_configuration(BIGINT, BOOLEAN, BOOLEAN, TEXT, TEXT, UUID),
  public.set_smtp_runtime_configuration(BIGINT, BOOLEAN, BOOLEAN, TEXT, INTEGER, TEXT, TEXT, TEXT, INTEGER, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_jellyfin_runtime_configuration(),
  public.get_smtp_runtime_configuration(),
  public.set_jellyfin_runtime_configuration(BIGINT, BOOLEAN, BOOLEAN, TEXT, TEXT, UUID),
  public.set_smtp_runtime_configuration(BIGINT, BOOLEAN, BOOLEAN, TEXT, INTEGER, TEXT, TEXT, TEXT, INTEGER, UUID)
  TO service_role;

DO $$
BEGIN
  IF has_function_privilege('authenticated', 'public.get_jellyfin_runtime_configuration()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_smtp_runtime_configuration()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.get_jellyfin_runtime_configuration()', 'EXECUTE') THEN
    RAISE EXCEPTION 'runtime configuration grants are wrong';
  END IF;
END
$$;
