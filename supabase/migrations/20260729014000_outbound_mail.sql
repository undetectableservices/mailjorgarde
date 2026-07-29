-- Private, durable audit and rate-limit ledger for authenticated outbound mail.
-- The browser never writes this table and PostgREST does not expose its schema.

ALTER TABLE public.drafts
  ADD COLUMN IF NOT EXISTS in_reply_to TEXT;
ALTER TABLE public.drafts
  DROP CONSTRAINT IF EXISTS drafts_in_reply_to_chk,
  ADD CONSTRAINT drafts_in_reply_to_chk
    CHECK (
      in_reply_to IS NULL
      OR (char_length(in_reply_to) <= 998 AND in_reply_to !~ E'[\\r\\n]')
    );

CREATE TABLE IF NOT EXISTS jorgarde_private.outbound_deliveries (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  mailbox_id UUID NOT NULL REFERENCES public.mailboxes(id) ON DELETE CASCADE,
  recipient_count INTEGER NOT NULL CHECK (recipient_count BETWEEN 1 AND 50),
  status TEXT NOT NULL DEFAULT 'queued',
  accepted_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
  rejected_count INTEGER NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
  relay_message_id TEXT,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ
);

ALTER TABLE jorgarde_private.outbound_deliveries
  DROP CONSTRAINT IF EXISTS outbound_deliveries_status_check,
  ADD CONSTRAINT outbound_deliveries_status_check
    CHECK (status IN ('queued', 'sent', 'failed', 'unknown'));

CREATE INDEX IF NOT EXISTS outbound_deliveries_user_created_idx
  ON jorgarde_private.outbound_deliveries (user_id, created_at DESC);

REVOKE ALL ON jorgarde_private.outbound_deliveries
  FROM PUBLIC, anon, authenticated, service_role;

-- Returns "reserved" for a new attempt, or the existing terminal state when
-- an HTTP retry reuses the same idempotency key. Limits are deliberately
-- conservative for a small private installation and stop a compromised user
-- account from turning the configured relay into a bulk-mail source.
CREATE OR REPLACE FUNCTION public.reserve_outbound_delivery(
  p_id UUID,
  p_user_id UUID,
  p_mailbox_id UUID,
  p_recipient_count INTEGER
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, jorgarde_private
AS $$
DECLARE
  existing jorgarde_private.outbound_deliveries%ROWTYPE;
  hourly_attempts INTEGER;
  daily_recipients BIGINT;
BEGIN
  IF p_id IS NULL OR p_user_id IS NULL OR p_mailbox_id IS NULL
     OR p_recipient_count NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'Invalid outbound reservation' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.mailboxes m
    WHERE m.id = p_mailbox_id
      AND m.user_id = p_user_id
      AND (NOT m.is_temp OR m.expires_at > clock_timestamp())
  ) THEN
    RAISE EXCEPTION 'Mailbox unavailable' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('jorgarde:outbound:' || p_user_id::TEXT, 0));

  SELECT * INTO existing
  FROM jorgarde_private.outbound_deliveries d
  WHERE d.id = p_id;
  IF FOUND THEN
    IF existing.user_id IS DISTINCT FROM p_user_id
       OR existing.mailbox_id IS DISTINCT FROM p_mailbox_id
       OR existing.recipient_count IS DISTINCT FROM p_recipient_count THEN
      RAISE EXCEPTION 'Idempotency key conflict' USING ERRCODE = '23505';
    END IF;
    RETURN existing.status;
  END IF;

  DELETE FROM jorgarde_private.outbound_deliveries
  WHERE created_at < clock_timestamp() - INTERVAL '30 days';

  SELECT count(*)::INTEGER INTO hourly_attempts
  FROM jorgarde_private.outbound_deliveries d
  WHERE d.user_id = p_user_id
    AND d.created_at >= clock_timestamp() - INTERVAL '1 hour';

  SELECT COALESCE(sum(d.recipient_count), 0)::BIGINT INTO daily_recipients
  FROM jorgarde_private.outbound_deliveries d
  WHERE d.user_id = p_user_id
    AND d.created_at >= clock_timestamp() - INTERVAL '24 hours';

  IF hourly_attempts >= 60 OR daily_recipients + p_recipient_count > 500 THEN
    RAISE EXCEPTION 'Outbound rate limit exceeded' USING ERRCODE = 'P5503';
  END IF;

  INSERT INTO jorgarde_private.outbound_deliveries (
    id, user_id, mailbox_id, recipient_count
  ) VALUES (
    p_id, p_user_id, p_mailbox_id, p_recipient_count
  );
  RETURN 'reserved';
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_outbound_delivery(
  p_id UUID,
  p_user_id UUID,
  p_status TEXT,
  p_accepted_count INTEGER DEFAULT 0,
  p_rejected_count INTEGER DEFAULT 0,
  p_relay_message_id TEXT DEFAULT NULL,
  p_error_code TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, jorgarde_private
AS $$
BEGIN
  IF p_status NOT IN ('sent', 'failed', 'unknown')
     OR p_accepted_count < 0 OR p_rejected_count < 0
     OR p_accepted_count + p_rejected_count > 50
     OR char_length(COALESCE(p_relay_message_id, '')) > 998
     OR char_length(COALESCE(p_error_code, '')) > 80 THEN
    RAISE EXCEPTION 'Invalid outbound completion' USING ERRCODE = '22023';
  END IF;

  UPDATE jorgarde_private.outbound_deliveries
  SET status = p_status,
      accepted_count = p_accepted_count,
      rejected_count = p_rejected_count,
      relay_message_id = NULLIF(left(COALESCE(p_relay_message_id, ''), 998), ''),
      error_code = NULLIF(left(COALESCE(p_error_code, ''), 80), ''),
      completed_at = clock_timestamp()
  WHERE id = p_id AND user_id = p_user_id AND status = 'queued';
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_outbound_delivery(UUID, UUID, UUID, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_outbound_delivery(UUID, UUID, TEXT, INTEGER, INTEGER, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_outbound_delivery(UUID, UUID, UUID, INTEGER)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_outbound_delivery(UUID, UUID, TEXT, INTEGER, INTEGER, TEXT, TEXT)
  TO service_role;

DO $$
BEGIN
  IF has_function_privilege('authenticated', 'public.reserve_outbound_delivery(uuid,uuid,uuid,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.reserve_outbound_delivery(uuid,uuid,uuid,integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.reserve_outbound_delivery(uuid,uuid,uuid,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'outbound invariant failed: reservation grants are wrong';
  END IF;
END
$$;
