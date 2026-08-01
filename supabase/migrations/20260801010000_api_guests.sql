-- Read-only developer API and short-lived guest accounts.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS api_access BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS account_kind TEXT NOT NULL DEFAULT 'member',
  ADD COLUMN IF NOT EXISTS guest_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMPTZ;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_account_kind_valid
    CHECK (account_kind IN ('member', 'guest')) NOT VALID,
  ADD CONSTRAINT profiles_guest_expiry_consistent
    CHECK (
      (account_kind = 'guest' AND guest_expires_at IS NOT NULL)
      OR (account_kind = 'member' AND guest_expires_at IS NULL)
    ) NOT VALID;

CREATE TABLE public.api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  key_hash TEXT NOT NULL UNIQUE CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  key_prefix TEXT NOT NULL CHECK (char_length(key_prefix) BETWEEN 8 AND 20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX api_keys_user_idx ON public.api_keys (user_id, created_at DESC);
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_keys FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.api_keys TO service_role;

CREATE TABLE public.api_mailboxes (
  mailbox_id UUID PRIMARY KEY REFERENCES public.mailboxes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX api_mailboxes_user_idx ON public.api_mailboxes (user_id, created_at DESC);
ALTER TABLE public.api_mailboxes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_mailboxes FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.api_mailboxes TO service_role;

CREATE TABLE public.guest_sessions (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  cleanup_secret_hash TEXT NOT NULL UNIQUE CHECK (cleanup_secret_hash ~ '^[a-f0-9]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  delete_after TIMESTAMPTZ
);
ALTER TABLE public.guest_sessions
  ADD CONSTRAINT guest_sessions_expiry_valid
  CHECK (expires_at > last_seen_at AND expires_at <= last_seen_at + interval '1 hour') NOT VALID;
ALTER TABLE public.guest_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.guest_sessions FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.guest_sessions TO service_role;

CREATE OR REPLACE FUNCTION public.check_account_active()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
BEGIN
  IF auth.role() = 'authenticated' AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND (
        p.suspended_until > clock_timestamp()
        OR (p.account_kind = 'guest' AND p.guest_expires_at <= clock_timestamp())
      )
  ) THEN
    RAISE EXCEPTION 'Account access suspended' USING ERRCODE = '42501';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.check_account_active() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_account_active() TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.enforce_guest_mailbox_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  kind TEXT;
  account_expiry TIMESTAMPTZ;
BEGIN
  SELECT p.account_kind, p.guest_expires_at INTO kind, account_expiry
  FROM public.profiles p WHERE p.user_id = NEW.user_id;
  IF kind = 'guest' THEN
    IF auth.uid() IS NOT NULL OR NOT NEW.is_temp OR NEW.expires_at IS NULL
       OR NEW.expires_at > account_expiry THEN
      RAISE EXCEPTION 'Guest mailboxes are managed by the service'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS enforce_guest_mailbox_write_trigger ON public.mailboxes;
CREATE TRIGGER enforce_guest_mailbox_write_trigger
  BEFORE INSERT OR UPDATE OF user_id, local_part, domain_id, is_temp, expires_at
  ON public.mailboxes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_guest_mailbox_write();

CREATE OR REPLACE FUNCTION public.block_guest_dm_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = NEW.sender_id AND p.account_kind = 'guest'
  ) THEN
    RAISE EXCEPTION 'Guest accounts cannot send direct messages' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS block_guest_dm_write_trigger ON public.dms;
CREATE TRIGGER block_guest_dm_write_trigger
  BEFORE INSERT ON public.dms
  FOR EACH ROW EXECUTE FUNCTION public.block_guest_dm_write();

CREATE OR REPLACE FUNCTION public.purge_expired_guest_accounts()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  removed INTEGER;
BEGIN
  WITH doomed AS (
    SELECT p.user_id
    FROM public.profiles p
    LEFT JOIN public.guest_sessions g ON g.user_id = p.user_id
    WHERE p.account_kind = 'guest'
      AND (
        p.guest_expires_at <= clock_timestamp()
        OR g.expires_at <= clock_timestamp()
        OR g.delete_after <= clock_timestamp()
      )
  )
  DELETE FROM auth.users u
  USING doomed d
  WHERE u.id = d.user_id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_expired_guest_accounts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_guest_accounts() TO service_role;
