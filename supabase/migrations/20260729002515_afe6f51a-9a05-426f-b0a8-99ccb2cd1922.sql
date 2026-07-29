CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  uname TEXT;
BEGIN
  uname := COALESCE(NEW.raw_user_meta_data->>'username', SPLIT_PART(NEW.email::text, '@', 1));
  IF EXISTS (SELECT 1 FROM public.profiles WHERE LOWER(username) = LOWER(uname)) THEN
    uname := uname || '-' || SUBSTRING(NEW.id::text, 1, 6);
  END IF;
  INSERT INTO public.profiles (user_id, username, display_name)
  VALUES (NEW.id, uname, COALESCE(NEW.raw_user_meta_data->>'display_name', uname));
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, CASE WHEN LOWER(uname) = 'admin' THEN 'admin'::app_role ELSE 'user'::app_role END);
  RETURN NEW;
END;
$function$;

INSERT INTO public.user_roles (user_id, role)
SELECT p.user_id, 'admin'::app_role FROM public.profiles p WHERE LOWER(p.username) = 'admin'
ON CONFLICT (user_id, role) DO NOTHING;

DELETE FROM public.user_roles ur
WHERE ur.role = 'admin'::app_role
  AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = ur.user_id AND LOWER(p.username) <> 'admin');