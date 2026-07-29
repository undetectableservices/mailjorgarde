-- Jellyfin identity claims are written only through the GoTrue admin API and
-- stored in raw_app_meta_data. Enforce one mail account per Jellyfin user at
-- the database layer so concurrent web processes cannot race the API scan.
CREATE UNIQUE INDEX IF NOT EXISTS auth_users_jellyfin_user_id_unique
  ON auth.users ((raw_app_meta_data->>'jellyfin_user_id'))
  WHERE raw_app_meta_data ? 'jellyfin_user_id';

-- Never infer ownership from account creation order. The installer provisions
-- an administrator with an app_metadata marker that ordinary users cannot set;
-- every other creation path, including Jellyfin registration, is a normal user.
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
  is_provisioned_admin BOOLEAN;
BEGIN
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
  is_provisioned_admin := COALESCE(
    lower(NEW.raw_app_meta_data->>'jorgarde_admin') IN ('true', '1', 'yes'),
    false
  );

  INSERT INTO public.profiles (user_id, username, display_name)
  VALUES (NEW.id, uname, display);

  INSERT INTO public.user_roles (user_id, role)
  VALUES (
    NEW.id,
    CASE WHEN is_provisioned_admin
      THEN 'admin'::public.app_role
      ELSE 'user'::public.app_role
    END
  );
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO supabase_auth_admin;
