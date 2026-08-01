-- Permanent, isolated developer mailboxes with activity auditing.

CREATE TABLE public.api_activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  api_key_id UUID REFERENCES public.api_keys(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (char_length(action) BETWEEN 1 AND 64),
  mailbox_id UUID,
  address TEXT CHECK (address IS NULL OR char_length(address) <= 320),
  status SMALLINT NOT NULL DEFAULT 200 CHECK (status BETWEEN 100 AND 599),
  client_ip TEXT CHECK (client_ip IS NULL OR char_length(client_ip) <= 64),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX api_activity_logs_user_created_idx
  ON public.api_activity_logs (user_id, created_at DESC);
CREATE INDEX api_activity_logs_mailbox_idx
  ON public.api_activity_logs (mailbox_id, created_at DESC)
  WHERE mailbox_id IS NOT NULL;
ALTER TABLE public.api_activity_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_activity_logs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.api_activity_logs TO service_role;

CREATE OR REPLACE FUNCTION public.is_api_mailbox(p_mailbox_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.api_mailboxes am WHERE am.mailbox_id = p_mailbox_id
  );
$$;
REVOKE ALL ON FUNCTION public.is_api_mailbox(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_api_mailbox(UUID) TO authenticated, service_role;

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

  SELECT domain.expires_at INTO domain_expiry
  FROM public.domains domain
  WHERE domain.id = NEW.domain_id;
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

    IF TG_OP = 'INSERT'
       AND NOT (is_required_alias AND public.has_role(caller, 'admin'::public.app_role)) THEN
      SELECT profile.mailbox_limit INTO caller_limit
      FROM public.profiles profile
      WHERE profile.user_id = caller
      FOR UPDATE;
      IF caller_limit IS NULL THEN
        RAISE EXCEPTION 'Profile not found' USING ERRCODE = '23503';
      END IF;

      SELECT count(*) INTO used_count
      FROM public.mailboxes mailbox
      WHERE mailbox.user_id = caller
        AND mailbox.local_part NOT IN ('postmaster', 'abuse')
        AND NOT public.is_api_mailbox(mailbox.id);
      IF used_count >= caller_limit THEN
        RAISE EXCEPTION 'Mailbox quota reached (% of %)', used_count, caller_limit
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Personal sender-blocking preferences must not silently hide messages from
-- an API consumer. API mailboxes expose every received message to their owner.
CREATE OR REPLACE FUNCTION public.route_blocked_message_to_spam()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner_id UUID;
BEGIN
  IF NEW.folder <> 'inbox' OR public.is_api_mailbox(NEW.mailbox_id) THEN
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

-- Existing API addresses from the first API version become permanent too.
UPDATE public.mailboxes mb
SET is_temp = false, expires_at = NULL
WHERE EXISTS (
  SELECT 1 FROM public.api_mailboxes am WHERE am.mailbox_id = mb.id
);
UPDATE public.messages msg
SET folder = 'inbox'
WHERE msg.folder IN ('archive', 'spam')
  AND public.is_api_mailbox(msg.mailbox_id);

CREATE OR REPLACE FUNCTION public.protect_api_mailbox_from_web_session()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND public.is_api_mailbox(OLD.id) THEN
    RAISE EXCEPTION 'API mailboxes are managed from the API console'
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.protect_api_mailbox_from_web_session()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS protect_api_mailbox_from_web_session_trigger ON public.mailboxes;
CREATE TRIGGER protect_api_mailbox_from_web_session_trigger
  BEFORE UPDATE OR DELETE ON public.mailboxes
  FOR EACH ROW EXECUTE FUNCTION public.protect_api_mailbox_from_web_session();

-- API mailboxes and their content are invisible to the authenticated browser
-- client. API routes and the dedicated console use the service role instead.
DROP POLICY IF EXISTS "mailboxes owner read" ON public.mailboxes;
DROP POLICY IF EXISTS "mailboxes owner update" ON public.mailboxes;
CREATE POLICY "mailboxes owner read" ON public.mailboxes FOR SELECT
  TO authenticated USING (
    user_id = auth.uid() AND NOT public.is_api_mailbox(id)
  );
CREATE POLICY "mailboxes owner update" ON public.mailboxes FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid() AND NOT public.is_api_mailbox(id))
  WITH CHECK (user_id = auth.uid() AND NOT public.is_api_mailbox(id));

DROP POLICY IF EXISTS "messages owner read" ON public.messages;
DROP POLICY IF EXISTS "messages owner update state" ON public.messages;
DROP POLICY IF EXISTS "messages owner delete" ON public.messages;
CREATE POLICY "messages owner read" ON public.messages FOR SELECT
  TO authenticated USING (
    NOT public.is_api_mailbox(messages.mailbox_id)
    AND EXISTS (
      SELECT 1 FROM public.mailboxes mb
      WHERE mb.id = messages.mailbox_id AND mb.user_id = auth.uid()
    )
  );
CREATE POLICY "messages owner update state" ON public.messages FOR UPDATE
  TO authenticated
  USING (
    NOT public.is_api_mailbox(messages.mailbox_id)
    AND EXISTS (
      SELECT 1 FROM public.mailboxes mb
      WHERE mb.id = messages.mailbox_id AND mb.user_id = auth.uid()
    )
  )
  WITH CHECK (
    NOT public.is_api_mailbox(messages.mailbox_id)
    AND EXISTS (
      SELECT 1 FROM public.mailboxes mb
      WHERE mb.id = messages.mailbox_id AND mb.user_id = auth.uid()
    )
  );
CREATE POLICY "messages owner delete" ON public.messages FOR DELETE
  TO authenticated USING (
    NOT public.is_api_mailbox(messages.mailbox_id)
    AND EXISTS (
      SELECT 1 FROM public.mailboxes mb
      WHERE mb.id = messages.mailbox_id AND mb.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "attachments via message" ON public.attachments;
CREATE POLICY "attachments via message" ON public.attachments FOR ALL
  TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.messages msg
    JOIN public.mailboxes mb ON mb.id = msg.mailbox_id
    WHERE msg.id = attachments.message_id
      AND mb.user_id = auth.uid()
      AND NOT public.is_api_mailbox(mb.id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1
    FROM public.messages msg
    JOIN public.mailboxes mb ON mb.id = msg.mailbox_id
    WHERE msg.id = attachments.message_id
      AND mb.user_id = auth.uid()
      AND NOT public.is_api_mailbox(mb.id)
  ));

DROP POLICY IF EXISTS "message_labels owner" ON public.message_labels;
CREATE POLICY "message_labels owner" ON public.message_labels FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.labels label
      WHERE label.id = message_labels.label_id AND label.user_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1
      FROM public.messages msg
      JOIN public.mailboxes mb ON mb.id = msg.mailbox_id
      WHERE msg.id = message_labels.message_id
        AND mb.user_id = auth.uid()
        AND NOT public.is_api_mailbox(mb.id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.labels label
      WHERE label.id = message_labels.label_id AND label.user_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1
      FROM public.messages msg
      JOIN public.mailboxes mb ON mb.id = msg.mailbox_id
      WHERE msg.id = message_labels.message_id
        AND mb.user_id = auth.uid()
        AND NOT public.is_api_mailbox(mb.id)
    )
  );

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
    profile.user_id,
    profile.username,
    profile.display_name,
    profile.mailbox_limit,
    profile.created_at,
    count(DISTINCT mailbox.id)::BIGINT,
    COALESCE(sum(message.size_bytes), 0)::BIGINT,
    COALESCE(
      array_agg(DISTINCT (mailbox.local_part || '@' || domain.name))
        FILTER (WHERE mailbox.id IS NOT NULL),
      ARRAY[]::TEXT[]
    )
  FROM public.profiles profile
  LEFT JOIN public.mailboxes mailbox
    ON mailbox.user_id = profile.user_id
    AND NOT public.is_api_mailbox(mailbox.id)
  LEFT JOIN public.domains domain ON domain.id = mailbox.domain_id
  LEFT JOIN public.messages message ON message.mailbox_id = mailbox.id
  GROUP BY
    profile.user_id,
    profile.username,
    profile.display_name,
    profile.mailbox_limit,
    profile.created_at
  ORDER BY profile.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_api_mailbox(
  p_user_id UUID,
  p_local_part TEXT,
  p_domain_name TEXT DEFAULT NULL
)
RETURNS TABLE (id UUID, address TEXT, created_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  normalized_local TEXT := lower(btrim(p_local_part));
  requested_domain TEXT := NULLIF(lower(btrim(p_domain_name)), '');
  selected_domain_id UUID;
  selected_domain_name TEXT;
  mailbox_id UUID;
  linked_at TIMESTAMPTZ;
  active_count INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles profile
    WHERE profile.user_id = p_user_id
      AND profile.account_kind = 'member'
      AND (
        profile.api_access
        OR public.has_role(p_user_id, 'admin'::public.app_role)
      )
      AND (
        profile.suspended_until IS NULL
        OR profile.suspended_until <= clock_timestamp()
      )
  ) THEN
    RAISE EXCEPTION 'API access forbidden' USING ERRCODE = '42501';
  END IF;

  IF normalized_local !~ '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$'
     OR position('..' IN normalized_local) > 0 THEN
    RAISE EXCEPTION 'Invalid mailbox local-part' USING ERRCODE = '22023';
  END IF;

  -- Serializes quota checks for one API owner and prevents concurrent requests
  -- from exceeding the strict 1,000-active-address ceiling.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::TEXT, 104729));
  SELECT count(*) INTO active_count
  FROM public.api_mailboxes am
  WHERE am.user_id = p_user_id;
  IF active_count >= 1000 THEN
    RAISE EXCEPTION 'API mailbox limit reached' USING ERRCODE = '23514';
  END IF;

  IF requested_domain IS NULL THEN
    SELECT domain.id, domain.name
    INTO selected_domain_id, selected_domain_name
    FROM public.domains domain
    WHERE (domain.expires_at IS NULL OR domain.expires_at > clock_timestamp())
      AND NOT EXISTS (
        SELECT 1 FROM public.mailboxes existing
        WHERE existing.domain_id = domain.id
          AND lower(existing.local_part) = normalized_local
      )
    ORDER BY random()
    LIMIT 1;
  ELSE
    SELECT domain.id, domain.name
    INTO selected_domain_id, selected_domain_name
    FROM public.domains domain
    WHERE lower(domain.name) = requested_domain
      AND (domain.expires_at IS NULL OR domain.expires_at > clock_timestamp())
    LIMIT 1;
  END IF;

  IF selected_domain_id IS NULL THEN
    IF requested_domain IS NULL THEN
      IF EXISTS (
        SELECT 1 FROM public.domains domain
        WHERE domain.expires_at IS NULL OR domain.expires_at > clock_timestamp()
      ) THEN
        RAISE EXCEPTION 'Address already exists on every active domain'
          USING ERRCODE = '23505';
      END IF;
      RAISE EXCEPTION 'No domain available for this address' USING ERRCODE = 'P0002';
    END IF;
    RAISE EXCEPTION 'Requested domain is unavailable' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.mailboxes existing
    WHERE existing.domain_id = selected_domain_id
      AND lower(existing.local_part) = normalized_local
  ) THEN
    RAISE EXCEPTION 'Address already exists' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.mailboxes (user_id, local_part, domain_id, is_temp, expires_at)
  VALUES (p_user_id, normalized_local, selected_domain_id, false, NULL)
  RETURNING mailboxes.id INTO mailbox_id;

  INSERT INTO public.api_mailboxes (mailbox_id, user_id)
  VALUES (mailbox_id, p_user_id)
  RETURNING api_mailboxes.created_at INTO linked_at;

  RETURN QUERY SELECT mailbox_id, normalized_local || '@' || selected_domain_name, linked_at;
END;
$$;

REVOKE ALL ON FUNCTION public.create_api_mailbox(UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_api_mailbox(UUID, TEXT, TEXT) TO service_role;

DO $$
BEGIN
  IF public.is_api_mailbox('00000000-0000-0000-0000-000000000000'::UUID) THEN
    RAISE EXCEPTION 'API platform invariant failed: unknown mailbox visibility';
  END IF;
END;
$$;
