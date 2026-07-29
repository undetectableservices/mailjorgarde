-- The private-messaging screen is an authenticated member directory.
-- It deliberately exposes only the same three public identity fields already
-- used in conversations, never email addresses or authentication metadata.

CREATE OR REPLACE FUNCTION public.list_dm_profiles()
RETURNS TABLE (user_id UUID, username TEXT, display_name TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  caller UUID := auth.uid();
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT p.user_id, p.username, p.display_name
  FROM public.profiles p
  WHERE p.user_id <> caller
  ORDER BY lower(p.username), p.user_id;
END;
$$;

-- Targeting the immutable user id avoids a second username lookup and makes a
-- member-card click idempotent: an existing canonical thread is returned,
-- otherwise exactly one thread is created even under concurrent clicks.
CREATE OR REPLACE FUNCTION public.start_dm_thread_by_user(p_user_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  caller UUID := auth.uid();
  first_user UUID;
  second_user UUID;
  thread_id UUID;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'User not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_user_id = caller THEN
    RAISE EXCEPTION 'Cannot message yourself' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = p_user_id) THEN
    RAISE EXCEPTION 'User not found' USING ERRCODE = 'P0002';
  END IF;

  first_user := least(caller, p_user_id);
  second_user := greatest(caller, p_user_id);

  INSERT INTO public.dm_threads (user_a, user_b)
  VALUES (first_user, second_user)
  ON CONFLICT (user_a, user_b)
  DO UPDATE SET last_at = public.dm_threads.last_at
  RETURNING id INTO thread_id;

  RETURN thread_id;
END;
$$;

-- Keep the username RPC compatible with old clients while funnelling all
-- creation through the same id-based implementation.
CREATE OR REPLACE FUNCTION public.start_dm_thread(p_username TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  target_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT p.user_id INTO target_id
  FROM public.profiles p
  WHERE lower(p.username) = lower(ltrim(btrim(COALESCE(p_username, '')), '@'));

  IF target_id IS NULL THEN
    RAISE EXCEPTION 'User not found' USING ERRCODE = 'P0002';
  END IF;

  RETURN public.start_dm_thread_by_user(target_id);
END;
$$;

REVOKE ALL ON FUNCTION public.list_dm_profiles() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.start_dm_thread_by_user(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_dm_profiles() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.start_dm_thread_by_user(UUID) TO authenticated, service_role;
