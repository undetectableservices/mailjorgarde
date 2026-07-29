-- JorgardeMail security and integrity hardening.
--
-- This is deliberately a new, ordered migration. Existing installations have
-- already recorded 001_app_schema.sql and would never see edits made only to
-- that file.

-- ---------------------------------------------------------------------------
-- Secure defaults and role helpers
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  -- Older installers created this ledger in PostgREST's exposed schema. The
  -- current installer migrates it to jorgarde_private before applying files;
  -- this block protects a database upgraded with an older runner as well.
  IF to_regclass('public._schema_migrations') IS NOT NULL THEN
    REVOKE ALL ON TABLE public._schema_migrations FROM PUBLIC, anon, authenticated, service_role;
    ALTER TABLE public._schema_migrations ENABLE ROW LEVEL SECURITY;
  END IF;
END
$$;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM PUBLIC;

-- Non-API state (migration bookkeeping and storage accounting) belongs in a
-- schema PostgREST roles cannot inspect or mutate.
CREATE SCHEMA IF NOT EXISTS jorgarde_private AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA jorgarde_private FROM PUBLIC, anon, authenticated, service_role;

-- Keep the legacy signature because existing policies and clients use it, but
-- do not let callers inspect another user's role by supplying an arbitrary ID.
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
  SELECT auth.uid() IS NOT NULL
     AND _user_id = auth.uid()
     AND EXISTS (
       SELECT 1
       FROM public.user_roles ur
       WHERE ur.user_id = _user_id AND ur.role = _role
     )
$$;

-- ---------------------------------------------------------------------------
-- Account bootstrap: first/provisioned owner, never a magic username
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  requested TEXT;
  uname TEXT;
  display TEXT;
  is_first_admin BOOLEAN;
  is_provisioned_admin BOOLEAN;
BEGIN
  -- Serialise username allocation and the first-admin decision. Two concurrent
  -- signups can no longer both become owner or race the unique username index.
  PERFORM pg_advisory_xact_lock(hashtextextended('jorgardemail:user-provisioning', 0));

  requested := lower(btrim(COALESCE(
    NULLIF(NEW.raw_user_meta_data->>'username', ''),
    split_part(NEW.email::text, '@', 1),
    ''
  )));

  IF requested !~ '^[a-z0-9][a-z0-9_-]{1,22}[a-z0-9]$' THEN
    requested := 'user-' || substring(replace(NEW.id::text, '-', ''), 1, 8);
  END IF;

  uname := requested;
  IF EXISTS (SELECT 1 FROM public.profiles p WHERE lower(p.username) = uname) THEN
    uname := left(requested, 11) || '-' || substring(replace(NEW.id::text, '-', ''), 1, 12);
  END IF;

  display := left(COALESCE(NULLIF(btrim(NEW.raw_user_meta_data->>'display_name'), ''), uname), 100);
  -- Only the genuinely first profile is promoted automatically. If every
  -- administrator is later removed, a public signup must not become the new
  -- owner merely because the role table is temporarily empty.
  is_first_admin := NOT EXISTS (SELECT 1 FROM public.profiles);
  -- raw_app_meta_data is controlled by GoTrue's admin/service-role API, unlike
  -- raw_user_meta_data supplied by public signup requests.
  is_provisioned_admin := COALESCE(
    lower(NEW.raw_app_meta_data->>'jorgarde_admin') IN ('true', '1', 'yes'),
    false
  );

  INSERT INTO public.profiles (user_id, username, display_name)
  VALUES (NEW.id, uname, display);

  INSERT INTO public.user_roles (user_id, role)
  VALUES (
    NEW.id,
    CASE WHEN is_first_admin OR is_provisioned_admin
      THEN 'admin'::public.app_role
      ELSE 'user'::public.app_role
    END
  );
  RETURN NEW;
END;
$$;

-- Recover an old installation left without an administrator by the previous
-- username-based migration. Never demote an existing administrator here.
DO $$
DECLARE
  oldest_user UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'admin'::public.app_role) THEN
    SELECT p.user_id INTO oldest_user
    FROM public.profiles p
    ORDER BY p.created_at, p.user_id
    LIMIT 1;

    IF oldest_user IS NOT NULL THEN
      INSERT INTO public.user_roles (user_id, role)
      VALUES (oldest_user, 'admin'::public.app_role)
      ON CONFLICT (user_id, role) DO NOTHING;
    END IF;
  END IF;
END
$$;

UPDATE public.profiles
SET mailbox_limit = LEAST(1000, GREATEST(0, mailbox_limit));

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_mailbox_limit_range CHECK (mailbox_limit BETWEEN 0 AND 1000),
  ADD CONSTRAINT profiles_username_format CHECK (
    username ~ '^[a-z0-9][a-z0-9_-]{1,22}[a-z0-9]$'
  ) NOT VALID,
  ADD CONSTRAINT profiles_display_name_length CHECK (
    display_name IS NULL OR char_length(display_name) <= 100
  ) NOT VALID;

DROP POLICY IF EXISTS "profiles readable" ON public.profiles;
DROP POLICY IF EXISTS "profiles update own" ON public.profiles;
DROP POLICY IF EXISTS "profiles admin update" ON public.profiles;

CREATE POLICY "profiles self or admin read" ON public.profiles FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR public.has_role(auth.uid(), 'admin'::public.app_role)
  );

-- Participants may resolve the other user's display information after a
-- thread exists. New-user discovery is exposed only through the privacy-aware
-- search_dm_profiles RPC below.
CREATE POLICY "profiles dm participant read" ON public.profiles FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.dm_threads t
    WHERE (t.user_a = auth.uid() AND t.user_b = profiles.user_id)
       OR (t.user_b = auth.uid() AND t.user_a = profiles.user_id)
  ));

CREATE POLICY "profiles update own preferences" ON public.profiles FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Direct profile reads expose only identity/display fields so a DM participant
-- cannot request another user's quota or private preferences. Owners retrieve
-- their complete row through this caller-bound function.
CREATE OR REPLACE FUNCTION public.get_my_profile()
RETURNS public.profiles
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  caller UUID := auth.uid();
  result public.profiles%ROWTYPE;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO result FROM public.profiles p WHERE p.user_id = caller;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Domains and mailboxes
-- ---------------------------------------------------------------------------

ALTER TABLE public.domains
  ADD CONSTRAINT domains_canonical_name CHECK (
    name = lower(name)
    AND char_length(name) BETWEEN 3 AND 253
    AND name ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
  ) NOT VALID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.domains GROUP BY lower(name) HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS domains_name_lower_unique
      ON public.domains (lower(name));
  END IF;
END
$$;

ALTER TABLE public.mailboxes
  ADD CONSTRAINT mailboxes_local_part_format CHECK (
    local_part = lower(local_part)
    AND char_length(local_part) BETWEEN 1 AND 64
    AND local_part ~ '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$'
    AND position('..' IN local_part) = 0
  ) NOT VALID,
  ADD CONSTRAINT mailboxes_temp_expiry_consistent CHECK (
    (is_temp AND expires_at IS NOT NULL)
    OR (NOT is_temp AND expires_at IS NULL)
  ) NOT VALID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.mailboxes
    GROUP BY lower(local_part), domain_id
    HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS mailboxes_address_lower_unique
      ON public.mailboxes (lower(local_part), domain_id);
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.enforce_mailbox_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  caller UUID := auth.uid();
  caller_limit INTEGER;
  used_count INTEGER;
  domain_expiry TIMESTAMPTZ;
  reserved_head TEXT;
  is_required_alias BOOLEAN;
BEGIN
  IF NEW.local_part <> lower(NEW.local_part)
     OR char_length(NEW.local_part) NOT BETWEEN 1 AND 64
     OR NEW.local_part !~ '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$'
     OR position('..' IN NEW.local_part) > 0 THEN
    RAISE EXCEPTION 'Invalid mailbox local-part' USING ERRCODE = '22023';
  END IF;

  IF NEW.is_temp THEN
    IF NEW.expires_at IS NULL
       OR NEW.expires_at <= clock_timestamp()
       OR NEW.expires_at > clock_timestamp() + interval '30 days' THEN
      RAISE EXCEPTION 'Temporary mailboxes require an expiry within 30 days'
        USING ERRCODE = '22023';
    END IF;
  ELSIF NEW.expires_at IS NOT NULL THEN
    RAISE EXCEPTION 'Permanent mailboxes cannot have an expiry' USING ERRCODE = '22023';
  END IF;

  SELECT d.expires_at INTO domain_expiry
  FROM public.domains d
  WHERE d.id = NEW.domain_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown domain' USING ERRCODE = '23503';
  END IF;
  IF domain_expiry IS NOT NULL AND domain_expiry <= clock_timestamp() THEN
    RAISE EXCEPTION 'Domain is expired' USING ERRCODE = '23514';
  END IF;

  IF caller IS NOT NULL AND auth.role() = 'authenticated' THEN
    IF NEW.user_id <> caller THEN
      RAISE EXCEPTION 'Cannot create or move another user''s mailbox' USING ERRCODE = '42501';
    END IF;

    reserved_head := regexp_replace(NEW.local_part, '[._-].*$', '');
    is_required_alias := NEW.local_part IN ('postmaster', 'abuse');
    IF (
      NEW.local_part = ANY (ARRAY[
        'admin','administrator','server','owner','root','postmaster','support',
        'no-reply','noreply','abuse','webmaster','hostmaster','security','info'
      ])
      OR reserved_head = ANY (ARRAY[
        'admin','administrator','server','owner','root','postmaster','support',
        'abuse','webmaster','hostmaster','security'
      ])
    ) AND NOT public.has_role(caller, 'admin'::public.app_role) THEN
      RAISE EXCEPTION 'That mailbox name is reserved for administrators'
        USING ERRCODE = '42501';
    END IF;

    -- RFC role addresses are provisioned for every domain and do not consume
    -- the administrator's personal mailbox allowance.
    IF TG_OP = 'INSERT'
       AND NOT (is_required_alias AND public.has_role(caller, 'admin'::public.app_role)) THEN
      SELECT p.mailbox_limit INTO caller_limit
      FROM public.profiles p
      WHERE p.user_id = caller
      FOR UPDATE;
      IF caller_limit IS NULL THEN
        RAISE EXCEPTION 'Profile not found' USING ERRCODE = '23503';
      END IF;

      SELECT count(*) INTO used_count
      FROM public.mailboxes m
      WHERE m.user_id = caller AND m.local_part NOT IN ('postmaster', 'abuse');
      IF used_count >= caller_limit THEN
        RAISE EXCEPTION 'Mailbox quota reached (% of %)', used_count, caller_limit
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_mailbox_write_trigger ON public.mailboxes;
CREATE TRIGGER enforce_mailbox_write_trigger
  BEFORE INSERT OR UPDATE OF user_id, local_part, domain_id, is_temp, expires_at
  ON public.mailboxes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_mailbox_write();

CREATE OR REPLACE FUNCTION public.provision_domain_role_mailboxes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  owner_id UUID := auth.uid();
BEGIN
  IF owner_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = owner_id AND ur.role = 'admin'::public.app_role
  ) THEN
    SELECT ur.user_id INTO owner_id
    FROM public.user_roles ur
    JOIN public.profiles p ON p.user_id = ur.user_id
    WHERE ur.role = 'admin'::public.app_role
    ORDER BY p.created_at, p.user_id
    LIMIT 1;
  END IF;

  -- A domain may be installed before its first owner account exists. The
  -- backfill below and subsequent admin domain writes cover the normal path;
  -- an installer can also add the domain after provisioning the owner.
  IF owner_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.mailboxes (user_id, local_part, domain_id, is_temp, expires_at)
  VALUES
    (owner_id, 'postmaster', NEW.id, false, NULL),
    (owner_id, 'abuse', NEW.id, false, NULL)
  ON CONFLICT (local_part, domain_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS provision_domain_role_mailboxes_trigger ON public.domains;
CREATE TRIGGER provision_domain_role_mailboxes_trigger
  AFTER INSERT ON public.domains
  FOR EACH ROW EXECUTE FUNCTION public.provision_domain_role_mailboxes();

-- A domain may exist before its first owner account (for example, when the
-- installer writes configuration first). Provision its mandatory role
-- addresses whenever an administrator is created or explicitly promoted.
CREATE OR REPLACE FUNCTION public.ensure_admin_domain_role_mailboxes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public.mailboxes (user_id, local_part, domain_id, is_temp, expires_at)
  SELECT NEW.user_id, alias.local_part, d.id, false, NULL
  FROM public.domains d
  CROSS JOIN (VALUES ('postmaster'::TEXT), ('abuse'::TEXT)) AS alias(local_part)
  ON CONFLICT (local_part, domain_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ensure_admin_domain_role_mailboxes_trigger ON public.user_roles;
CREATE TRIGGER ensure_admin_domain_role_mailboxes_trigger
  AFTER INSERT OR UPDATE OF role ON public.user_roles
  FOR EACH ROW
  WHEN (NEW.role = 'admin'::public.app_role)
  EXECUTE FUNCTION public.ensure_admin_domain_role_mailboxes();

-- Upgrade existing domains as well. Required role aliases belong to the oldest
-- current administrator and are exempt from regular quota accounting.
WITH owner AS (
  SELECT ur.user_id
  FROM public.user_roles ur
  JOIN public.profiles p ON p.user_id = ur.user_id
  WHERE ur.role = 'admin'::public.app_role
  ORDER BY p.created_at, p.user_id
  LIMIT 1
)
INSERT INTO public.mailboxes (user_id, local_part, domain_id, is_temp, expires_at)
SELECT owner.user_id, alias.local_part, d.id, false, NULL
FROM owner
CROSS JOIN public.domains d
CROSS JOIN (VALUES ('postmaster'::TEXT), ('abuse'::TEXT)) AS alias(local_part)
ON CONFLICT (local_part, domain_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.create_mailbox(
  p_local_part TEXT,
  p_domain_id UUID,
  p_is_temp BOOLEAN DEFAULT false,
  p_ttl_minutes INTEGER DEFAULT NULL
)
RETURNS public.mailboxes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  caller UUID := auth.uid();
  result public.mailboxes%ROWTYPE;
  expiry TIMESTAMPTZ;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_is_temp THEN
    IF p_ttl_minutes IS NULL OR p_ttl_minutes NOT BETWEEN 10 AND 43200 THEN
      RAISE EXCEPTION 'Temporary lifetime must be between 10 and 43200 minutes'
        USING ERRCODE = '22023';
    END IF;
    expiry := clock_timestamp() + make_interval(mins => p_ttl_minutes);
  ELSE
    expiry := NULL;
  END IF;

  -- Expired temporary addresses no longer consume quota or block reuse.
  DELETE FROM public.mailboxes
  WHERE user_id = caller AND is_temp AND expires_at <= clock_timestamp();

  INSERT INTO public.mailboxes (user_id, local_part, domain_id, is_temp, expires_at)
  VALUES (caller, lower(btrim(p_local_part)), p_domain_id, p_is_temp, expiry)
  RETURNING * INTO result;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_mailbox_lifetime(
  p_mailbox_id UUID,
  p_ttl_minutes INTEGER DEFAULT NULL
)
RETURNS public.mailboxes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  caller UUID := auth.uid();
  current_box public.mailboxes%ROWTYPE;
  result public.mailboxes%ROWTYPE;
  expiry TIMESTAMPTZ;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO current_box
  FROM public.mailboxes
  WHERE id = p_mailbox_id AND user_id = caller
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mailbox not found' USING ERRCODE = 'P0002';
  END IF;
  IF current_box.local_part IN ('postmaster', 'abuse') THEN
    RAISE EXCEPTION 'Required domain aliases must remain permanent'
      USING ERRCODE = '23514';
  END IF;
  IF current_box.is_temp AND current_box.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'Expired temporary mailbox cannot be restored' USING ERRCODE = '23514';
  END IF;

  IF p_ttl_minutes IS NULL THEN
    UPDATE public.mailboxes
    SET is_temp = false, expires_at = NULL
    WHERE id = p_mailbox_id
    RETURNING * INTO result;
  ELSE
    IF p_ttl_minutes NOT BETWEEN 10 AND 43200 THEN
      RAISE EXCEPTION 'Temporary lifetime must be between 10 and 43200 minutes'
        USING ERRCODE = '22023';
    END IF;
    expiry := GREATEST(clock_timestamp(), COALESCE(current_box.expires_at, clock_timestamp()))
      + make_interval(mins => p_ttl_minutes);
    IF expiry > clock_timestamp() + interval '30 days' THEN
      expiry := clock_timestamp() + interval '30 days';
    END IF;
    UPDATE public.mailboxes
    SET is_temp = true, expires_at = expiry
    WHERE id = p_mailbox_id
    RETURNING * INTO result;
  END IF;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_mailbox(p_mailbox_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  caller UUID := auth.uid();
  mailbox_name TEXT;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT m.local_part INTO mailbox_name
  FROM public.mailboxes m
  WHERE m.id = p_mailbox_id AND m.user_id = caller
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mailbox not found' USING ERRCODE = 'P0002';
  END IF;
  IF mailbox_name IN ('postmaster', 'abuse') THEN
    RAISE EXCEPTION 'Required domain aliases cannot be deleted'
      USING ERRCODE = '23514';
  END IF;

  DELETE FROM public.mailboxes WHERE id = p_mailbox_id;
  RETURN mailbox_name;
END;
$$;

CREATE OR REPLACE FUNCTION public.purge_expired_mailboxes()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  removed INTEGER;
BEGIN
  DELETE FROM public.mailboxes
  WHERE is_temp AND expires_at <= clock_timestamp();
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

DROP POLICY IF EXISTS "mailboxes owner" ON public.mailboxes;
DROP POLICY IF EXISTS "mailboxes owner delete" ON public.mailboxes;
CREATE POLICY "mailboxes owner read" ON public.mailboxes FOR SELECT
  TO authenticated USING (user_id = auth.uid());
CREATE POLICY "mailboxes owner update" ON public.mailboxes FOR UPDATE
  TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Mail integrity and least-privilege message access
-- ---------------------------------------------------------------------------

ALTER TABLE public.attachments
  ADD COLUMN IF NOT EXISTS content_base64 TEXT,
  ADD COLUMN IF NOT EXISTS content_disposition TEXT,
  ADD COLUMN IF NOT EXISTS content_id TEXT;

ALTER TABLE public.messages
  ADD CONSTRAINT messages_size_nonnegative CHECK (size_bytes >= 0) NOT VALID,
  ADD CONSTRAINT messages_sender_length CHECK (char_length(sender) <= 998) NOT VALID,
  ADD CONSTRAINT messages_recipient_length CHECK (char_length(recipient_addr) <= 998) NOT VALID,
  ADD CONSTRAINT messages_subject_length CHECK (subject IS NULL OR char_length(subject) <= 998) NOT VALID;

-- Storage accounting is based on the raw RFC message size. That already
-- includes MIME attachments, so counting attachment metadata separately would
-- double-charge users. Defaults are 5 GiB per mailbox and 25 GiB globally.
INSERT INTO public.settings (key, value)
VALUES
  ('mailbox_storage_limit_bytes', to_jsonb(5368709120::BIGINT)),
  ('global_storage_limit_bytes', to_jsonb(26843545600::BIGINT))
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS jorgarde_private.mailbox_storage_usage (
  mailbox_id UUID PRIMARY KEY REFERENCES public.mailboxes(id) ON DELETE CASCADE,
  used_bytes BIGINT NOT NULL DEFAULT 0 CHECK (used_bytes >= 0)
);
CREATE TABLE IF NOT EXISTS jorgarde_private.global_storage_usage (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  used_bytes BIGINT NOT NULL DEFAULT 0 CHECK (used_bytes >= 0)
);
-- This ledger makes BEFORE INSERT reservations retry-safe. PostgreSQL executes
-- BEFORE triggers even for INSERT ... ON CONFLICT DO NOTHING; the deterministic
-- message UUID prevents a webhook replay from charging quota twice.
CREATE TABLE IF NOT EXISTS jorgarde_private.message_storage_ledger (
  message_id UUID PRIMARY KEY,
  mailbox_id UUID NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0)
);

REVOKE ALL ON jorgarde_private.mailbox_storage_usage,
  jorgarde_private.global_storage_usage,
  jorgarde_private.message_storage_ledger
  FROM PUBLIC, anon, authenticated, service_role;

TRUNCATE TABLE
  jorgarde_private.message_storage_ledger,
  jorgarde_private.mailbox_storage_usage,
  jorgarde_private.global_storage_usage;

INSERT INTO jorgarde_private.message_storage_ledger (message_id, mailbox_id, size_bytes)
SELECT id, mailbox_id, GREATEST(size_bytes, 0)::BIGINT
FROM public.messages;
INSERT INTO jorgarde_private.mailbox_storage_usage (mailbox_id, used_bytes)
SELECT mailbox_id, sum(GREATEST(size_bytes, 0))::BIGINT
FROM public.messages
GROUP BY mailbox_id;
INSERT INTO jorgarde_private.global_storage_usage (singleton, used_bytes)
SELECT true, COALESCE(sum(GREATEST(size_bytes, 0)), 0)::BIGINT
FROM public.messages;

CREATE OR REPLACE FUNCTION jorgarde_private.configured_storage_limit(
  p_key TEXT,
  p_default BIGINT
)
RETURNS BIGINT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, jorgarde_private
AS $$
DECLARE
  value_type TEXT;
  raw_value TEXT;
  result BIGINT;
BEGIN
  SELECT jsonb_typeof(s.value), s.value #>> '{}'
    INTO value_type, raw_value
  FROM public.settings s
  WHERE s.key = p_key;

  IF NOT FOUND THEN
    RETURN p_default;
  END IF;
  IF value_type <> 'number' OR raw_value !~ '^[0-9]{1,18}$' THEN
    RAISE EXCEPTION 'Storage setting % must be a positive integer JSON number', p_key
      USING ERRCODE = '22023';
  END IF;
  result := raw_value::BIGINT;
  IF result < 1048576 THEN
    RAISE EXCEPTION 'Storage setting % must be at least 1048576 bytes', p_key
      USING ERRCODE = '22023';
  END IF;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.reserve_message_storage()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, jorgarde_private
AS $$
DECLARE
  prior jorgarde_private.message_storage_ledger%ROWTYPE;
  mailbox_used BIGINT;
  global_used BIGINT;
  mailbox_limit BIGINT;
  global_limit BIGINT;
  attempted BIGINT;
BEGIN
  IF NEW.size_bytes < 0 THEN
    RAISE EXCEPTION 'Message size cannot be negative' USING ERRCODE = '22023';
  END IF;

  -- One transaction-scoped lock serialises both the per-mailbox and global
  -- checks. The reservation itself is transactional and rolls back with any
  -- later FK, CHECK, attachment, or RPC failure.
  PERFORM pg_advisory_xact_lock(hashtextextended('jorgarde:storage-quota', 0));

  SELECT * INTO prior
  FROM jorgarde_private.message_storage_ledger l
  WHERE l.message_id = NEW.id;
  IF FOUND THEN
    IF prior.mailbox_id IS DISTINCT FROM NEW.mailbox_id
       OR prior.size_bytes IS DISTINCT FROM NEW.size_bytes::BIGINT THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P5502',
        MESSAGE = 'JORGARDE_MESSAGE_ID_CONFLICT',
        DETAIL = format('message_id=%s', NEW.id);
    END IF;
    RETURN NEW;
  END IF;

  INSERT INTO jorgarde_private.mailbox_storage_usage (mailbox_id, used_bytes)
  VALUES (NEW.mailbox_id, 0)
  ON CONFLICT (mailbox_id) DO NOTHING;

  SELECT u.used_bytes INTO mailbox_used
  FROM jorgarde_private.mailbox_storage_usage u
  WHERE u.mailbox_id = NEW.mailbox_id
  FOR UPDATE;
  SELECT g.used_bytes INTO global_used
  FROM jorgarde_private.global_storage_usage g
  WHERE g.singleton
  FOR UPDATE;
  IF mailbox_used IS NULL OR global_used IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P5503',
      MESSAGE = 'JORGARDE_STORAGE_COUNTER_CORRUPT';
  END IF;

  mailbox_limit := jorgarde_private.configured_storage_limit(
    'mailbox_storage_limit_bytes', 5368709120::BIGINT
  );
  global_limit := jorgarde_private.configured_storage_limit(
    'global_storage_limit_bytes', 26843545600::BIGINT
  );

  attempted := mailbox_used + NEW.size_bytes::BIGINT;
  IF attempted > mailbox_limit THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P5501',
      MESSAGE = 'JORGARDE_STORAGE_QUOTA_EXCEEDED',
      DETAIL = format(
        'kind=mailbox;mailbox_id=%s;used=%s;incoming=%s;limit=%s',
        NEW.mailbox_id, mailbox_used, NEW.size_bytes, mailbox_limit
      );
  END IF;
  attempted := global_used + NEW.size_bytes::BIGINT;
  IF attempted > global_limit THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P5501',
      MESSAGE = 'JORGARDE_STORAGE_QUOTA_EXCEEDED',
      DETAIL = format(
        'kind=global;used=%s;incoming=%s;limit=%s',
        global_used, NEW.size_bytes, global_limit
      );
  END IF;

  INSERT INTO jorgarde_private.message_storage_ledger (message_id, mailbox_id, size_bytes)
  VALUES (NEW.id, NEW.mailbox_id, NEW.size_bytes::BIGINT);
  UPDATE jorgarde_private.mailbox_storage_usage
  SET used_bytes = used_bytes + NEW.size_bytes::BIGINT
  WHERE mailbox_id = NEW.mailbox_id;
  UPDATE jorgarde_private.global_storage_usage
  SET used_bytes = used_bytes + NEW.size_bytes::BIGINT
  WHERE singleton;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_message_storage()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, jorgarde_private
AS $$
DECLARE
  prior jorgarde_private.message_storage_ledger%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('jorgarde:storage-quota', 0));
  DELETE FROM jorgarde_private.message_storage_ledger l
  WHERE l.message_id = OLD.id
  RETURNING * INTO prior;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P5503',
      MESSAGE = 'JORGARDE_STORAGE_COUNTER_CORRUPT',
      DETAIL = format('missing message_id=%s', OLD.id);
  END IF;

  -- The per-mailbox row can already be gone during a mailbox CASCADE. The
  -- global row remains authoritative and is always adjusted.
  UPDATE jorgarde_private.mailbox_storage_usage
  SET used_bytes = GREATEST(0, used_bytes - prior.size_bytes)
  WHERE mailbox_id = prior.mailbox_id;
  UPDATE jorgarde_private.global_storage_usage
  SET used_bytes = GREATEST(0, used_bytes - prior.size_bytes)
  WHERE singleton;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION public.protect_message_storage_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.mailbox_id IS DISTINCT FROM OLD.mailbox_id
     OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes THEN
    RAISE EXCEPTION 'Message id, mailbox, and accounted size are immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.reset_message_storage_after_truncate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, jorgarde_private
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('jorgarde:storage-quota', 0));
  TRUNCATE TABLE jorgarde_private.message_storage_ledger;
  UPDATE jorgarde_private.mailbox_storage_usage SET used_bytes = 0;
  UPDATE jorgarde_private.global_storage_usage SET used_bytes = 0 WHERE singleton;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS reserve_message_storage_trigger ON public.messages;
CREATE TRIGGER reserve_message_storage_trigger
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.reserve_message_storage();
DROP TRIGGER IF EXISTS release_message_storage_trigger ON public.messages;
CREATE TRIGGER release_message_storage_trigger
  BEFORE DELETE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.release_message_storage();
DROP TRIGGER IF EXISTS protect_message_storage_identity_trigger ON public.messages;
CREATE TRIGGER protect_message_storage_identity_trigger
  BEFORE UPDATE OF id, mailbox_id, size_bytes ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.protect_message_storage_identity();
DROP TRIGGER IF EXISTS reset_message_storage_after_truncate_trigger ON public.messages;
CREATE TRIGGER reset_message_storage_after_truncate_trigger
  AFTER TRUNCATE ON public.messages
  FOR EACH STATEMENT EXECUTE FUNCTION public.reset_message_storage_after_truncate();

CREATE OR REPLACE FUNCTION public.enforce_message_mailbox_active()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  mailbox_temp BOOLEAN;
  mailbox_expiry TIMESTAMPTZ;
  domain_expiry TIMESTAMPTZ;
BEGIN
  -- A retry of an already committed deterministic delivery must remain a
  -- no-op even if the mailbox expires before the webhook is replayed.
  IF TG_OP = 'INSERT' AND EXISTS (
    SELECT 1 FROM public.messages existing WHERE existing.id = NEW.id
  ) THEN
    RETURN NEW;
  END IF;

  SELECT m.is_temp, m.expires_at, d.expires_at
    INTO mailbox_temp, mailbox_expiry, domain_expiry
  FROM public.mailboxes m
  JOIN public.domains d ON d.id = m.domain_id
  WHERE m.id = NEW.mailbox_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mailbox not found' USING ERRCODE = '23503';
  END IF;
  IF mailbox_temp AND mailbox_expiry <= clock_timestamp() THEN
    RAISE EXCEPTION 'Mailbox is expired' USING ERRCODE = '23514';
  END IF;
  IF domain_expiry IS NOT NULL AND domain_expiry <= clock_timestamp() THEN
    RAISE EXCEPTION 'Domain is expired' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_message_mailbox_active_trigger ON public.messages;
CREATE TRIGGER enforce_message_mailbox_active_trigger
  BEFORE INSERT OR UPDATE OF mailbox_id ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.enforce_message_mailbox_active();

-- Store a complete multi-recipient inbound delivery in one PostgreSQL
-- transaction. Only the service role can execute this RPC. Deterministic IDs
-- make an exact signed-webhook replay a no-op without content-based deduping.
CREATE OR REPLACE FUNCTION public.store_inbound_delivery(
  p_messages JSONB,
  p_attachments JSONB
)
RETURNS TABLE (messages INTEGER, attachments INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  item JSONB;
  changed INTEGER;
  message_uuid UUID;
  mailbox_uuid UUID;
  parent_uuid UUID;
  sender_value TEXT;
  recipient_value TEXT;
  subject_value TEXT;
  body_text_value TEXT;
  body_html_value TEXT;
  raw_value TEXT;
  header_message_id TEXT;
  reply_to_value TEXT;
  message_size INTEGER;
  attachment_uuid UUID;
  filename_value TEXT;
  mime_value TEXT;
  attachment_size INTEGER;
  path_value TEXT;
  base64_value TEXT;
  disposition_value TEXT;
  content_id_value TEXT;
  decoded_size INTEGER;
BEGIN
  IF jsonb_typeof(p_messages) IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_attachments) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Inbound messages and attachments must be JSON arrays'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_messages) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Inbound delivery must contain between 1 and 100 messages'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_attachments) > 10000 THEN
    RAISE EXCEPTION 'Inbound delivery contains too many attachment rows'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_messages) e(value)
    WHERE jsonb_typeof(e.value) <> 'object'
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_attachments) e(value)
    WHERE jsonb_typeof(e.value) <> 'object'
  ) THEN
    RAISE EXCEPTION 'Inbound delivery arrays must contain only objects'
      USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_messages)) <>
     (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(p_messages)) THEN
    RAISE EXCEPTION 'Inbound message IDs must be present and unique'
      USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_attachments)) <>
     (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(p_attachments)) THEN
    RAISE EXCEPTION 'Inbound attachment IDs must be present and unique'
      USING ERRCODE = '22023';
  END IF;

  messages := 0;
  attachments := 0;

  FOR item IN SELECT value FROM jsonb_array_elements(p_messages)
  LOOP
    IF NOT (item ?& ARRAY[
      'id','mailbox_id','sender','recipient_addr','subject','body_text',
      'body_html','raw','message_id','in_reply_to','size_bytes'
    ]) OR (item - ARRAY[
      'id','mailbox_id','sender','recipient_addr','subject','body_text',
      'body_html','raw','message_id','in_reply_to','size_bytes'
    ]) <> '{}'::JSONB THEN
      RAISE EXCEPTION 'Inbound message object has missing or unknown fields'
        USING ERRCODE = '22023';
    END IF;

    message_uuid := (item->>'id')::UUID;
    mailbox_uuid := (item->>'mailbox_id')::UUID;
    sender_value := item->>'sender';
    recipient_value := item->>'recipient_addr';
    subject_value := item->>'subject';
    body_text_value := item->>'body_text';
    body_html_value := item->>'body_html';
    raw_value := item->>'raw';
    header_message_id := item->>'message_id';
    reply_to_value := item->>'in_reply_to';
    message_size := (item->>'size_bytes')::INTEGER;

    IF message_uuid IS NULL OR mailbox_uuid IS NULL
       OR sender_value IS NULL OR recipient_value IS NULL OR raw_value IS NULL
       OR message_size IS NULL OR message_size NOT BETWEEN 0 AND 26214400 THEN
      RAISE EXCEPTION 'Inbound message contains invalid required values'
        USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.messages (
      id, mailbox_id, sender, recipient_addr, subject, body_text, body_html,
      raw, message_id, in_reply_to, size_bytes
    ) VALUES (
      message_uuid, mailbox_uuid, sender_value, recipient_value, subject_value,
      body_text_value, body_html_value, raw_value, header_message_id,
      reply_to_value, message_size
    )
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS changed = ROW_COUNT;
    messages := messages + changed;

    IF changed = 0 AND NOT EXISTS (
      SELECT 1 FROM public.messages existing
      WHERE existing.id = message_uuid
        AND existing.mailbox_id IS NOT DISTINCT FROM mailbox_uuid
        AND existing.sender IS NOT DISTINCT FROM sender_value
        AND existing.recipient_addr IS NOT DISTINCT FROM recipient_value
        AND existing.subject IS NOT DISTINCT FROM subject_value
        AND existing.body_text IS NOT DISTINCT FROM body_text_value
        AND existing.body_html IS NOT DISTINCT FROM body_html_value
        AND existing.raw IS NOT DISTINCT FROM raw_value
        AND existing.message_id IS NOT DISTINCT FROM header_message_id
        AND existing.in_reply_to IS NOT DISTINCT FROM reply_to_value
        AND existing.size_bytes IS NOT DISTINCT FROM message_size
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P5502',
        MESSAGE = 'JORGARDE_MESSAGE_ID_CONFLICT',
        DETAIL = format('message_id=%s', message_uuid);
    END IF;
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(p_attachments)
  LOOP
    IF NOT (item ?& ARRAY[
      'id','message_id','filename','mime','size','storage_path',
      'content_base64','content_disposition','content_id'
    ]) OR (item - ARRAY[
      'id','message_id','filename','mime','size','storage_path',
      'content_base64','content_disposition','content_id'
    ]) <> '{}'::JSONB THEN
      RAISE EXCEPTION 'Inbound attachment object has missing or unknown fields'
        USING ERRCODE = '22023';
    END IF;

    attachment_uuid := (item->>'id')::UUID;
    parent_uuid := (item->>'message_id')::UUID;
    filename_value := item->>'filename';
    mime_value := item->>'mime';
    attachment_size := (item->>'size')::INTEGER;
    path_value := item->>'storage_path';
    base64_value := item->>'content_base64';
    disposition_value := item->>'content_disposition';
    content_id_value := item->>'content_id';

    IF attachment_uuid IS NULL OR parent_uuid IS NULL
       OR filename_value IS NULL OR filename_value = '' OR char_length(filename_value) > 512
       OR mime_value IS NULL OR char_length(mime_value) > 255
       OR path_value IS NULL OR path_value = ''
       OR base64_value IS NULL
       OR disposition_value IS NULL OR char_length(disposition_value) > 32
       OR attachment_size IS NULL OR attachment_size NOT BETWEEN 0 AND 26214400 THEN
      RAISE EXCEPTION 'Inbound attachment contains invalid required values'
        USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_messages) source(value)
      WHERE (source.value->>'id')::UUID = parent_uuid
    ) THEN
      RAISE EXCEPTION 'Inbound attachment does not reference a message in this delivery'
        USING ERRCODE = '22023';
    END IF;

    BEGIN
      decoded_size := octet_length(decode(base64_value, 'base64'));
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Inbound attachment content is not valid base64'
        USING ERRCODE = '22023';
    END;
    IF decoded_size <> attachment_size THEN
      RAISE EXCEPTION 'Inbound attachment decoded size does not match metadata'
        USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.attachments (
      id, message_id, filename, mime, size, storage_path, content_base64,
      content_disposition, content_id
    ) VALUES (
      attachment_uuid, parent_uuid, filename_value, mime_value, attachment_size,
      path_value, base64_value, disposition_value, content_id_value
    )
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS changed = ROW_COUNT;
    attachments := attachments + changed;

    IF changed = 0 AND NOT EXISTS (
      SELECT 1 FROM public.attachments existing
      WHERE existing.id = attachment_uuid
        AND existing.message_id IS NOT DISTINCT FROM parent_uuid
        AND existing.filename IS NOT DISTINCT FROM filename_value
        AND existing.mime IS NOT DISTINCT FROM mime_value
        AND existing.size IS NOT DISTINCT FROM attachment_size
        AND existing.storage_path IS NOT DISTINCT FROM path_value
        AND existing.content_base64 IS NOT DISTINCT FROM base64_value
        AND existing.content_disposition IS NOT DISTINCT FROM disposition_value
        AND existing.content_id IS NOT DISTINCT FROM content_id_value
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P5502',
        MESSAGE = 'JORGARDE_ATTACHMENT_ID_CONFLICT',
        DETAIL = format('attachment_id=%s', attachment_uuid);
    END IF;
  END LOOP;

  RETURN NEXT;
END;
$$;

DROP POLICY IF EXISTS "messages via mailbox" ON public.messages;
DROP POLICY IF EXISTS "messages admin read" ON public.messages;
CREATE POLICY "messages owner read" ON public.messages FOR SELECT
  TO authenticated USING (EXISTS (
    SELECT 1 FROM public.mailboxes m
    WHERE m.id = messages.mailbox_id AND m.user_id = auth.uid()
  ));
CREATE POLICY "messages owner update state" ON public.messages FOR UPDATE
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.mailboxes m
    WHERE m.id = messages.mailbox_id AND m.user_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.mailboxes m
    WHERE m.id = messages.mailbox_id AND m.user_id = auth.uid()
  ));
CREATE POLICY "messages owner delete" ON public.messages FOR DELETE
  TO authenticated USING (EXISTS (
    SELECT 1 FROM public.mailboxes m
    WHERE m.id = messages.mailbox_id AND m.user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "message_labels owner" ON public.message_labels;
CREATE POLICY "message_labels owner" ON public.message_labels FOR ALL
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.labels l
            WHERE l.id = message_labels.label_id AND l.user_id = auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.messages msg
      JOIN public.mailboxes mb ON mb.id = msg.mailbox_id
      WHERE msg.id = message_labels.message_id AND mb.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.labels l
            WHERE l.id = message_labels.label_id AND l.user_id = auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.messages msg
      JOIN public.mailboxes mb ON mb.id = msg.mailbox_id
      WHERE msg.id = message_labels.message_id AND mb.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "drafts owner" ON public.drafts;
CREATE POLICY "drafts owner" ON public.drafts FOR ALL
  TO authenticated
  USING (
    user_id = auth.uid()
    AND (from_mailbox_id IS NULL OR EXISTS (
      SELECT 1 FROM public.mailboxes m
      WHERE m.id = drafts.from_mailbox_id AND m.user_id = auth.uid()
    ))
  )
  WITH CHECK (
    user_id = auth.uid()
    AND (from_mailbox_id IS NULL OR EXISTS (
      SELECT 1 FROM public.mailboxes m
      WHERE m.id = drafts.from_mailbox_id AND m.user_id = auth.uid()
    ))
  );

-- ---------------------------------------------------------------------------
-- Canonical, immutable, privacy-aware direct messages
-- ---------------------------------------------------------------------------

-- Repair any reversed duplicate pairs left by direct API writes before adding
-- canonical constraints. Legitimate UI-created pairs were already sorted.
DELETE FROM public.dm_threads WHERE user_a = user_b;

CREATE TEMP TABLE dm_thread_merge ON COMMIT DROP AS
SELECT
  id AS old_id,
  first_value(id) OVER pair_window AS keep_id,
  least(user_a, user_b) AS canonical_a,
  greatest(user_a, user_b) AS canonical_b,
  max(last_at) OVER pair_window AS newest_at
FROM public.dm_threads
WINDOW pair_window AS (
  PARTITION BY least(user_a, user_b), greatest(user_a, user_b)
  ORDER BY id
  ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
);

UPDATE public.dms d
SET thread_id = m.keep_id
FROM dm_thread_merge m
WHERE d.thread_id = m.old_id AND m.old_id <> m.keep_id;

DELETE FROM public.dm_threads t
USING dm_thread_merge m
WHERE t.id = m.old_id AND m.old_id <> m.keep_id;

UPDATE public.dm_threads t
SET user_a = m.canonical_a, user_b = m.canonical_b, last_at = m.newest_at
FROM (
  SELECT DISTINCT keep_id, canonical_a, canonical_b, newest_at
  FROM dm_thread_merge
) m
WHERE t.id = m.keep_id;

-- Remove structurally forged legacy rows; they could otherwise be exposed by
-- participant-only RLS despite not belonging to the thread's actual pair.
DELETE FROM public.dms d
WHERE NOT EXISTS (
  SELECT 1 FROM public.dm_threads t
  WHERE t.id = d.thread_id
    AND (
      (d.sender_id = t.user_a AND d.recipient_id = t.user_b)
      OR (d.sender_id = t.user_b AND d.recipient_id = t.user_a)
    )
);

ALTER TABLE public.dm_threads
  ADD CONSTRAINT dm_threads_distinct_users CHECK (user_a <> user_b),
  ADD CONSTRAINT dm_threads_canonical_pair CHECK (user_a < user_b);
ALTER TABLE public.dms
  ADD CONSTRAINT dms_distinct_users CHECK (sender_id <> recipient_id),
  ADD CONSTRAINT dms_body_length CHECK (char_length(body) BETWEEN 1 AND 10000) NOT VALID;

CREATE OR REPLACE FUNCTION public.protect_dm_thread_participants()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.user_a IS DISTINCT FROM OLD.user_a OR NEW.user_b IS DISTINCT FROM OLD.user_b THEN
    RAISE EXCEPTION 'DM thread participants are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_dm_thread_participants_trigger ON public.dm_threads;
CREATE TRIGGER protect_dm_thread_participants_trigger
  BEFORE UPDATE ON public.dm_threads
  FOR EACH ROW EXECUTE FUNCTION public.protect_dm_thread_participants();

CREATE OR REPLACE FUNCTION public.validate_dm_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  t public.dm_threads%ROWTYPE;
BEGIN
  NEW.body := btrim(NEW.body);
  IF char_length(NEW.body) NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'DM body must be between 1 and 10000 characters'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO t FROM public.dm_threads WHERE id = NEW.thread_id;
  IF NOT FOUND OR NOT (
    (NEW.sender_id = t.user_a AND NEW.recipient_id = t.user_b)
    OR (NEW.sender_id = t.user_b AND NEW.recipient_id = t.user_a)
  ) THEN
    RAISE EXCEPTION 'DM sender and recipient do not match the thread'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.protect_dm_content()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.thread_id IS DISTINCT FROM OLD.thread_id
     OR NEW.sender_id IS DISTINCT FROM OLD.sender_id
     OR NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
     OR NEW.body IS DISTINCT FROM OLD.body
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'DM routing and content are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.touch_dm_thread()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.dm_threads SET last_at = NEW.created_at WHERE id = NEW.thread_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_dm_insert_trigger ON public.dms;
CREATE TRIGGER validate_dm_insert_trigger
  BEFORE INSERT ON public.dms
  FOR EACH ROW EXECUTE FUNCTION public.validate_dm_insert();
DROP TRIGGER IF EXISTS protect_dm_content_trigger ON public.dms;
CREATE TRIGGER protect_dm_content_trigger
  BEFORE UPDATE ON public.dms
  FOR EACH ROW EXECUTE FUNCTION public.protect_dm_content();
DROP TRIGGER IF EXISTS touch_dm_thread_trigger ON public.dms;
CREATE TRIGGER touch_dm_thread_trigger
  AFTER INSERT ON public.dms
  FOR EACH ROW EXECUTE FUNCTION public.touch_dm_thread();

DROP POLICY IF EXISTS "dm_threads participant read" ON public.dm_threads;
DROP POLICY IF EXISTS "dm_threads participant insert" ON public.dm_threads;
DROP POLICY IF EXISTS "dm_threads participant update" ON public.dm_threads;
CREATE POLICY "dm_threads participant read" ON public.dm_threads FOR SELECT
  TO authenticated USING (user_a = auth.uid() OR user_b = auth.uid());

DROP POLICY IF EXISTS "dms participant read" ON public.dms;
DROP POLICY IF EXISTS "dms sender insert" ON public.dms;
DROP POLICY IF EXISTS "dms sender update" ON public.dms;
DROP POLICY IF EXISTS "dms recipient seen update" ON public.dms;
CREATE POLICY "dms thread participant read" ON public.dms FOR SELECT
  TO authenticated USING (EXISTS (
    SELECT 1 FROM public.dm_threads t
    WHERE t.id = dms.thread_id
      AND (t.user_a = auth.uid() OR t.user_b = auth.uid())
      AND (
        (dms.sender_id = t.user_a AND dms.recipient_id = t.user_b)
        OR (dms.sender_id = t.user_b AND dms.recipient_id = t.user_a)
      )
  ));

DROP POLICY IF EXISTS "dm_attachments participant" ON public.dm_attachments;
CREATE POLICY "dm_attachments participant read" ON public.dm_attachments FOR SELECT
  TO authenticated USING (EXISTS (
    SELECT 1 FROM public.dms d
    WHERE d.id = dm_attachments.dm_id
      AND (d.sender_id = auth.uid() OR d.recipient_id = auth.uid())
  ));
CREATE POLICY "dm_attachments sender insert" ON public.dm_attachments FOR INSERT
  TO authenticated WITH CHECK (EXISTS (
    SELECT 1 FROM public.dms d
    WHERE d.id = dm_attachments.dm_id AND d.sender_id = auth.uid()
  ));
CREATE POLICY "dm_attachments sender delete" ON public.dm_attachments FOR DELETE
  TO authenticated USING (EXISTS (
    SELECT 1 FROM public.dms d
    WHERE d.id = dm_attachments.dm_id AND d.sender_id = auth.uid()
  ));

CREATE OR REPLACE FUNCTION public.search_dm_profiles(
  p_query TEXT,
  p_limit INTEGER DEFAULT 6
)
RETURNS TABLE (user_id UUID, username TEXT, display_name TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  caller UUID := auth.uid();
  query_text TEXT := lower(ltrim(btrim(COALESCE(p_query, '')), '@'));
  result_limit INTEGER := LEAST(20, GREATEST(1, COALESCE(p_limit, 6)));
BEGIN
  IF caller IS NULL OR query_text !~ '^[a-z0-9_-]{1,24}$' THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT p.user_id, p.username, p.display_name
  FROM public.profiles p
  WHERE p.user_id <> caller
    AND p.dm_privacy = 'anyone'
    AND lower(p.username) LIKE query_text || '%'
  ORDER BY lower(p.username)
  LIMIT result_limit;
END;
$$;

CREATE OR REPLACE FUNCTION public.start_dm_thread(p_username TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  caller UUID := auth.uid();
  target public.profiles%ROWTYPE;
  first_user UUID;
  second_user UUID;
  thread_id UUID;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO target
  FROM public.profiles p
  WHERE lower(p.username) = lower(ltrim(btrim(COALESCE(p_username, '')), '@'));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found' USING ERRCODE = 'P0002';
  END IF;
  IF target.user_id = caller THEN
    RAISE EXCEPTION 'Cannot message yourself' USING ERRCODE = '22023';
  END IF;

  first_user := least(caller, target.user_id);
  second_user := greatest(caller, target.user_id);

  SELECT t.id INTO thread_id
  FROM public.dm_threads t
  WHERE t.user_a = first_user AND t.user_b = second_user;
  IF thread_id IS NOT NULL THEN
    RETURN thread_id;
  END IF;

  -- The current schema has no contacts relation. Treat "contacts" as closed
  -- instead of silently weakening the user's privacy setting.
  IF target.dm_privacy <> 'anyone' THEN
    RAISE EXCEPTION 'This user is not accepting new direct messages'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.dm_threads (user_a, user_b)
  VALUES (first_user, second_user)
  ON CONFLICT (user_a, user_b) DO UPDATE SET last_at = public.dm_threads.last_at
  RETURNING id INTO thread_id;
  RETURN thread_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.send_dm(p_thread_id UUID, p_body TEXT)
RETURNS public.dms
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  caller UUID := auth.uid();
  thread public.dm_threads%ROWTYPE;
  recipient UUID;
  clean_body TEXT := btrim(COALESCE(p_body, ''));
  result public.dms%ROWTYPE;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF char_length(clean_body) NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'DM body must be between 1 and 10000 characters'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO thread
  FROM public.dm_threads t
  WHERE t.id = p_thread_id AND (t.user_a = caller OR t.user_b = caller);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Thread not found' USING ERRCODE = 'P0002';
  END IF;
  recipient := CASE WHEN thread.user_a = caller THEN thread.user_b ELSE thread.user_a END;

  INSERT INTO public.dms (thread_id, sender_id, recipient_id, body)
  VALUES (thread.id, caller, recipient, clean_body)
  RETURNING * INTO result;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_dm_thread_seen(p_thread_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  caller UUID := auth.uid();
  changed INTEGER;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.dm_threads t
    WHERE t.id = p_thread_id AND (t.user_a = caller OR t.user_b = caller)
  ) THEN
    RAISE EXCEPTION 'Thread not found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.dms
  SET seen_at = COALESCE(seen_at, clock_timestamp())
  WHERE thread_id = p_thread_id AND recipient_id = caller AND seen_at IS NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END;
$$;

-- ---------------------------------------------------------------------------
-- Narrow admin operations that do not expose every message body via RLS
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_user_stats()
RETURNS TABLE (
  user_id UUID,
  username TEXT,
  display_name TEXT,
  mailbox_limit INTEGER,
  created_at TIMESTAMPTZ,
  mailbox_count BIGINT,
  storage_bytes BIGINT,
  addresses TEXT[]
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    p.user_id,
    p.username,
    p.display_name,
    p.mailbox_limit,
    p.created_at,
    count(DISTINCT mb.id)::BIGINT,
    COALESCE(sum(msg.size_bytes), 0)::BIGINT,
    COALESCE(
      array_agg(DISTINCT (mb.local_part || '@' || d.name)) FILTER (WHERE mb.id IS NOT NULL),
      ARRAY[]::TEXT[]
    )
  FROM public.profiles p
  LEFT JOIN public.mailboxes mb ON mb.user_id = p.user_id
  LEFT JOIN public.domains d ON d.id = mb.domain_id
  LEFT JOIN public.messages msg ON msg.mailbox_id = mb.id
  GROUP BY p.user_id, p.username, p.display_name, p.mailbox_limit, p.created_at
  ORDER BY p.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_mailbox_limit(p_user_id UUID, p_limit INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 0 AND 1000 THEN
    RAISE EXCEPTION 'Mailbox limit must be between 0 and 1000' USING ERRCODE = '22023';
  END IF;

  UPDATE public.profiles SET mailbox_limit = p_limit WHERE user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_storage_limits(
  p_mailbox_limit_bytes BIGINT,
  p_global_limit_bytes BIGINT
)
RETURNS TABLE (mailbox_limit_bytes BIGINT, global_limit_bytes BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_mailbox_limit_bytes IS NULL OR p_global_limit_bytes IS NULL
     OR p_mailbox_limit_bytes NOT BETWEEN 1048576::BIGINT AND 1125899906842624::BIGINT
     OR p_global_limit_bytes NOT BETWEEN 1048576::BIGINT AND 1125899906842624::BIGINT
     OR p_global_limit_bytes < p_mailbox_limit_bytes THEN
    RAISE EXCEPTION 'Storage limits must be 1 MiB to 1 PiB and global must be at least mailbox'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.settings (key, value)
  VALUES
    ('mailbox_storage_limit_bytes', to_jsonb(p_mailbox_limit_bytes)),
    ('global_storage_limit_bytes', to_jsonb(p_global_limit_bytes))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = clock_timestamp();

  mailbox_limit_bytes := p_mailbox_limit_bytes;
  global_limit_bytes := p_global_limit_bytes;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_domain(p_domain_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  deleted_name TEXT;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT d.name INTO deleted_name
  FROM public.domains d
  WHERE d.id = p_domain_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Domain not found' USING ERRCODE = 'P0002';
  END IF;

  -- domains.mailboxes is RESTRICT by design. This explicit administrator RPC
  -- is the single deliberate cascade boundary: mailbox deletion cascades mail,
  -- attachments and quota-ledger releases before the domain row is removed.
  DELETE FROM public.mailboxes WHERE domain_id = p_domain_id;
  DELETE FROM public.domains WHERE id = p_domain_id;
  RETURN deleted_name;
END;
$$;

-- ---------------------------------------------------------------------------
-- Explicit grants: RLS is not a substitute for least-privilege table grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public.user_roles TO authenticated;
GRANT SELECT (user_id, username, display_name) ON public.profiles TO authenticated;
GRANT UPDATE (display_name, dm_privacy, density) ON public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.domains TO authenticated;
GRANT SELECT ON public.mailboxes TO authenticated;
GRANT UPDATE (
  display_name, signature, signature_placement, default_reply_mode, auto_bcc, hidden
) ON public.mailboxes TO authenticated;
GRANT SELECT, DELETE ON public.messages TO authenticated;
GRANT UPDATE (folder, seen, starred, snoozed_until) ON public.messages TO authenticated;
GRANT SELECT ON public.attachments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.labels TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.message_labels TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.drafts TO authenticated;
GRANT SELECT ON public.dm_threads TO authenticated;
GRANT SELECT ON public.dms TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.dm_attachments TO authenticated;
GRANT SELECT ON public.settings TO authenticated;

GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(UUID, public.app_role) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_profile() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_mailbox(TEXT, UUID, BOOLEAN, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_mailbox_lifetime(UUID, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.delete_mailbox(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.search_dm_profiles(TEXT, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.start_dm_thread(TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.send_dm(UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_dm_thread_seen(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_user_stats() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_mailbox_limit(UUID, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_storage_limits(BIGINT, BIGINT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.delete_domain(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.purge_expired_mailboxes() TO service_role;
GRANT EXECUTE ON FUNCTION public.store_inbound_delivery(JSONB, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO supabase_auth_admin;

-- Fail the migration instead of silently shipping an accidentally widened API.
DO $$
BEGIN
  IF has_table_privilege('authenticated', 'public.mailboxes', 'INSERT') THEN
    RAISE EXCEPTION 'hardening invariant failed: authenticated can insert mailboxes directly';
  END IF;
  IF has_table_privilege('authenticated', 'public.mailboxes', 'DELETE') THEN
    RAISE EXCEPTION 'hardening invariant failed: required aliases bypass delete_mailbox';
  END IF;
  IF has_column_privilege('authenticated', 'public.mailboxes', 'is_temp', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.mailboxes', 'expires_at', 'UPDATE') THEN
    RAISE EXCEPTION 'hardening invariant failed: mailbox lifetime columns are directly writable';
  END IF;
  IF has_table_privilege('authenticated', 'public.messages', 'INSERT') THEN
    RAISE EXCEPTION 'hardening invariant failed: authenticated can forge stored mail';
  END IF;
  IF has_table_privilege('authenticated', 'public.domains', 'DELETE') THEN
    RAISE EXCEPTION 'hardening invariant failed: domains bypass the confirmed delete RPC';
  END IF;
  IF has_table_privilege('authenticated', 'public.dm_threads', 'INSERT')
     OR has_table_privilege('authenticated', 'public.dm_threads', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.dms', 'INSERT')
     OR has_table_privilege('authenticated', 'public.dms', 'UPDATE') THEN
    RAISE EXCEPTION 'hardening invariant failed: DM tables bypass secure RPCs';
  END IF;
  IF has_column_privilege('authenticated', 'public.profiles', 'mailbox_limit', 'UPDATE') THEN
    RAISE EXCEPTION 'hardening invariant failed: users can raise their own mailbox quota';
  END IF;
  IF has_table_privilege('authenticated', 'public.profiles', 'SELECT') THEN
    RAISE EXCEPTION 'hardening invariant failed: direct profile reads expose private columns';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.send_dm(uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.send_dm(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'hardening invariant failed: send_dm execution grants are wrong';
  END IF;
  IF has_function_privilege('authenticated', 'public.store_inbound_delivery(jsonb,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.store_inbound_delivery(jsonb,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.store_inbound_delivery(jsonb,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'hardening invariant failed: inbound storage RPC grants are wrong';
  END IF;
END
$$;
