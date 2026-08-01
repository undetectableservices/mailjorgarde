-- Personal mailbox data must stay owner-only, including for administrators.
-- Administrative mailbox management uses authenticated server functions with
-- the service role and therefore does not need a browser-wide RLS exception.

DROP POLICY IF EXISTS "mailboxes admin read" ON public.mailboxes;
DROP POLICY IF EXISTS "mailboxes admin delete" ON public.mailboxes;

-- Reassert the complete owner policy after removing the legacy permissive
-- policies. PostgreSQL ORs permissive policies, so a broad admin policy would
-- otherwise override the owner predicate below.
DROP POLICY IF EXISTS "mailboxes owner read" ON public.mailboxes;
DROP POLICY IF EXISTS "mailboxes owner update" ON public.mailboxes;

CREATE POLICY "mailboxes owner read" ON public.mailboxes FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    AND NOT public.is_api_mailbox(id)
  );

CREATE POLICY "mailboxes owner update" ON public.mailboxes FOR UPDATE
  TO authenticated
  USING (
    user_id = auth.uid()
    AND NOT public.is_api_mailbox(id)
  )
  WITH CHECK (
    user_id = auth.uid()
    AND NOT public.is_api_mailbox(id)
  );

-- Migration-time regression guard: fail installation if a legacy policy is
-- ever restored or the two owner-only policies are missing.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'mailboxes'
      AND policyname IN ('mailboxes admin read', 'mailboxes admin delete')
  ) THEN
    RAISE EXCEPTION 'mailbox isolation invariant failed: legacy admin policy remains';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'mailboxes'
      AND policyname IN ('mailboxes owner read', 'mailboxes owner update')
  ) <> 2 THEN
    RAISE EXCEPTION 'mailbox isolation invariant failed: owner policies are incomplete';
  END IF;
END;
$$;
