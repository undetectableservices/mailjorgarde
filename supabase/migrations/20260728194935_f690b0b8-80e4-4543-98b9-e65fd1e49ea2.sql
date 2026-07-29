
CREATE POLICY "profiles admin update" ON public.profiles FOR UPDATE
  TO authenticated USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "user_roles admin read" ON public.user_roles FOR SELECT
  TO authenticated USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  uname TEXT;
  is_first BOOLEAN;
BEGIN
  uname := COALESCE(NEW.raw_user_meta_data->>'username', SPLIT_PART(NEW.email::text, '@', 1));
  IF EXISTS (SELECT 1 FROM public.profiles WHERE LOWER(username) = LOWER(uname)) THEN
    uname := uname || '-' || SUBSTRING(NEW.id::text, 1, 6);
  END IF;
  SELECT NOT EXISTS (SELECT 1 FROM public.profiles) INTO is_first;
  INSERT INTO public.profiles (user_id, username, display_name)
  VALUES (NEW.id, uname, COALESCE(NEW.raw_user_meta_data->>'display_name', uname));
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, CASE WHEN is_first THEN 'admin'::app_role ELSE 'user'::app_role END);
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE TABLE public.domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.domains TO authenticated;
GRANT ALL ON public.domains TO service_role;
ALTER TABLE public.domains ENABLE ROW LEVEL SECURITY;
CREATE POLICY "domains read" ON public.domains FOR SELECT TO authenticated USING (true);
CREATE POLICY "domains admin write" ON public.domains FOR ALL
  TO authenticated USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

CREATE TABLE public.mailboxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  local_part TEXT NOT NULL,
  domain_id UUID NOT NULL REFERENCES public.domains(id) ON DELETE RESTRICT,
  is_temp BOOLEAN NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ,
  display_name TEXT,
  signature TEXT,
  signature_placement TEXT NOT NULL DEFAULT 'below' CHECK (signature_placement IN ('below','above','none')),
  default_reply_mode TEXT NOT NULL DEFAULT 'reply' CHECK (default_reply_mode IN ('reply','reply_all')),
  auto_bcc TEXT,
  hidden BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (local_part, domain_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mailboxes TO authenticated;
GRANT ALL ON public.mailboxes TO service_role;
ALTER TABLE public.mailboxes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "mailboxes owner" ON public.mailboxes FOR ALL
  TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "mailboxes admin read" ON public.mailboxes FOR SELECT
  TO authenticated USING (public.has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "mailboxes admin delete" ON public.mailboxes FOR DELETE
  TO authenticated USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE INDEX mailboxes_user_idx ON public.mailboxes (user_id);
CREATE INDEX mailboxes_expiry_idx ON public.mailboxes (expires_at) WHERE is_temp = true;
