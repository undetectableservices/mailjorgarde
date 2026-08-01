-- Mailbox controls: sender blocking, automatic spam routing and exact lifetimes.

CREATE TABLE public.blocked_senders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  mailbox_id UUID REFERENCES public.mailboxes(id) ON DELETE CASCADE,
  match_type TEXT NOT NULL CHECK (match_type IN ('email', 'domain')),
  match_value TEXT NOT NULL CHECK (char_length(match_value) BETWEEN 1 AND 320),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX blocked_senders_scope_unique
  ON public.blocked_senders (
    user_id,
    COALESCE(mailbox_id, '00000000-0000-0000-0000-000000000000'::UUID),
    match_type,
    match_value
  );
CREATE INDEX blocked_senders_lookup_idx
  ON public.blocked_senders (user_id, mailbox_id, match_type, match_value);

ALTER TABLE public.blocked_senders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "blocked senders owner read" ON public.blocked_senders
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "blocked senders owner delete" ON public.blocked_senders
  FOR DELETE TO authenticated USING (user_id = auth.uid());
REVOKE ALL ON public.blocked_senders FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON public.blocked_senders TO authenticated;
GRANT ALL ON public.blocked_senders TO service_role;

CREATE OR REPLACE FUNCTION public.extract_sender_email(p_sender TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT lower(btrim(COALESCE(
    substring(p_sender FROM '<[[:space:]]*([^<>[:space:]]+@[^<>[:space:]]+)[[:space:]]*>'),
    substring(
      p_sender
      FROM '([A-Za-z0-9.!#$%&''*+/=?^_{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63})'
    )
  )));
$$;

CREATE OR REPLACE FUNCTION public.sender_matches_block(
  p_sender TEXT,
  p_match_type TEXT,
  p_match_value TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE p_match_type
    WHEN 'email' THEN public.extract_sender_email(p_sender) = p_match_value
    WHEN 'domain' THEN
      split_part(COALESCE(public.extract_sender_email(p_sender), ''), '@', 2) = p_match_value
    ELSE false
  END;
$$;

CREATE OR REPLACE FUNCTION public.route_blocked_message_to_spam()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner_id UUID;
BEGIN
  IF NEW.folder <> 'inbox' THEN
    RETURN NEW;
  END IF;

  SELECT mb.user_id INTO owner_id
  FROM public.mailboxes mb
  WHERE mb.id = NEW.mailbox_id;

  IF owner_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.blocked_senders rule
    WHERE rule.user_id = owner_id
      AND (rule.mailbox_id IS NULL OR rule.mailbox_id = NEW.mailbox_id)
      AND public.sender_matches_block(NEW.sender, rule.match_type, rule.match_value)
  ) THEN
    NEW.folder := 'spam';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS route_blocked_message_to_spam_trigger ON public.messages;
CREATE TRIGGER route_blocked_message_to_spam_trigger
  BEFORE INSERT OR UPDATE OF sender, mailbox_id, folder
  ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.route_blocked_message_to_spam();

CREATE OR REPLACE FUNCTION public.create_block_rule(
  p_match_type TEXT,
  p_match_value TEXT,
  p_mailbox_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  caller UUID := auth.uid();
  normalized TEXT;
  rule_id UUID;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_match_type NOT IN ('email', 'domain') THEN
    RAISE EXCEPTION 'Block type must be email or domain' USING ERRCODE = '22023';
  END IF;

  normalized := lower(btrim(p_match_value));
  IF p_match_type = 'domain' THEN
    normalized := regexp_replace(normalized, '^@+', '');
    IF char_length(normalized) > 253
       OR normalized !~ '^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' THEN
      RAISE EXCEPTION 'Invalid sender domain' USING ERRCODE = '22023';
    END IF;
  ELSIF normalized !~ '^[^<>()[:space:]@]{1,64}@[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$' THEN
    RAISE EXCEPTION 'Invalid sender email' USING ERRCODE = '22023';
  END IF;

  IF p_mailbox_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.mailboxes mb
    WHERE mb.id = p_mailbox_id AND mb.user_id = caller
  ) THEN
    RAISE EXCEPTION 'Mailbox not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.blocked_senders (user_id, mailbox_id, match_type, match_value)
  VALUES (caller, p_mailbox_id, p_match_type, normalized)
  ON CONFLICT DO NOTHING
  RETURNING id INTO rule_id;

  IF rule_id IS NULL THEN
    SELECT rule.id INTO rule_id
    FROM public.blocked_senders rule
    WHERE rule.user_id = caller
      AND rule.mailbox_id IS NOT DISTINCT FROM p_mailbox_id
      AND rule.match_type = p_match_type
      AND rule.match_value = normalized;
  END IF;

  UPDATE public.messages msg
  SET folder = 'spam'
  FROM public.mailboxes mb
  WHERE msg.mailbox_id = mb.id
    AND mb.user_id = caller
    AND (p_mailbox_id IS NULL OR mb.id = p_mailbox_id)
    AND msg.folder IN ('inbox', 'archive')
    AND public.sender_matches_block(msg.sender, p_match_type, normalized);

  RETURN rule_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_mailbox_remaining(
  p_mailbox_id UUID,
  p_ttl_minutes INTEGER
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
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_ttl_minutes NOT BETWEEN 10 AND 43200 THEN
    RAISE EXCEPTION 'Remaining lifetime must be between 10 and 43200 minutes'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO current_box
  FROM public.mailboxes
  WHERE id = p_mailbox_id AND user_id = caller
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mailbox not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT current_box.is_temp THEN
    RAISE EXCEPTION 'Only temporary mailboxes have a remaining lifetime'
      USING ERRCODE = '23514';
  END IF;
  IF current_box.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'Expired temporary mailbox cannot be restored' USING ERRCODE = '23514';
  END IF;

  UPDATE public.mailboxes
  SET expires_at = clock_timestamp() + make_interval(mins => p_ttl_minutes)
  WHERE id = p_mailbox_id
  RETURNING * INTO result;
  RETURN result;
END;
$$;

DO $$
BEGIN
  IF public.extract_sender_email('Example User <User+tag@Example.COM>')
       IS DISTINCT FROM 'user+tag@example.com' THEN
    RAISE EXCEPTION 'mail controls invariant failed: sender extraction';
  END IF;
  IF NOT public.sender_matches_block('Sender <sender@news.example.com>', 'domain', 'news.example.com') THEN
    RAISE EXCEPTION 'mail controls invariant failed: domain matching';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.extract_sender_email(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sender_matches_block(TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.route_blocked_message_to_spam()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_block_rule(TEXT, TEXT, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_mailbox_remaining(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_block_rule(TEXT, TEXT, UUID)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_mailbox_remaining(UUID, INTEGER)
  TO authenticated, service_role;
