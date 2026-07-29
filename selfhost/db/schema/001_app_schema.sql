CREATE TYPE public.app_role AS ENUM ('admin', 'user');

CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;

CREATE POLICY "users read own roles" ON public.user_roles FOR SELECT
  TO authenticated USING (user_id = auth.uid());

CREATE TABLE public.profiles (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  display_name TEXT,
  mailbox_limit INTEGER NOT NULL DEFAULT 30,
  dm_privacy TEXT NOT NULL DEFAULT 'anyone' CHECK (dm_privacy IN ('anyone','contacts','nobody')),
  density TEXT NOT NULL DEFAULT 'cozy' CHECK (density IN ('cozy','compact')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX profiles_username_lower_idx ON public.profiles (LOWER(username));
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles readable" ON public.profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "profiles update own" ON public.profiles FOR UPDATE
  TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

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
  expires_at TIMESTAMPTZ,
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

REVOKE ALL ON FUNCTION public.has_role(UUID, app_role) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

CREATE TABLE public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id UUID NOT NULL REFERENCES public.mailboxes(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,
  recipient_addr TEXT NOT NULL,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  raw TEXT,
  folder TEXT NOT NULL DEFAULT 'inbox' CHECK (folder IN ('inbox','sent','drafts','starred','archive','trash','spam','snoozed')),
  seen BOOLEAN NOT NULL DEFAULT false,
  starred BOOLEAN NOT NULL DEFAULT false,
  snoozed_until TIMESTAMPTZ,
  thread_id TEXT,
  in_reply_to TEXT,
  message_id TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.messages TO authenticated;
GRANT ALL ON public.messages TO service_role;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "messages via mailbox" ON public.messages FOR ALL
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.mailboxes m WHERE m.id = messages.mailbox_id AND m.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.mailboxes m WHERE m.id = messages.mailbox_id AND m.user_id = auth.uid()));
CREATE POLICY "messages admin read" ON public.messages FOR SELECT
  TO authenticated USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE INDEX messages_mailbox_folder_idx ON public.messages (mailbox_id, folder, received_at DESC);
CREATE INDEX messages_unseen_idx ON public.messages (mailbox_id) WHERE seen = false;

CREATE TABLE public.attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  storage_path TEXT NOT NULL
);
GRANT SELECT, INSERT, DELETE ON public.attachments TO authenticated;
GRANT ALL ON public.attachments TO service_role;
ALTER TABLE public.attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "attachments via message" ON public.attachments FOR ALL
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.messages msg JOIN public.mailboxes mb ON mb.id = msg.mailbox_id
    WHERE msg.id = attachments.message_id AND mb.user_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.messages msg JOIN public.mailboxes mb ON mb.id = msg.mailbox_id
    WHERE msg.id = attachments.message_id AND mb.user_id = auth.uid()
  ));

CREATE TABLE public.labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#c9a84c',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.labels TO authenticated;
GRANT ALL ON public.labels TO service_role;
ALTER TABLE public.labels ENABLE ROW LEVEL SECURITY;
CREATE POLICY "labels owner" ON public.labels FOR ALL
  TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE TABLE public.message_labels (
  message_id UUID NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  label_id UUID NOT NULL REFERENCES public.labels(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, label_id)
);
GRANT SELECT, INSERT, DELETE ON public.message_labels TO authenticated;
GRANT ALL ON public.message_labels TO service_role;
ALTER TABLE public.message_labels ENABLE ROW LEVEL SECURITY;
CREATE POLICY "message_labels owner" ON public.message_labels FOR ALL
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.labels l WHERE l.id = message_labels.label_id AND l.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.labels l WHERE l.id = message_labels.label_id AND l.user_id = auth.uid()));

CREATE TABLE public.drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  from_mailbox_id UUID REFERENCES public.mailboxes(id) ON DELETE SET NULL,
  to_addr TEXT,
  cc TEXT,
  bcc TEXT,
  subject TEXT,
  body TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.drafts TO authenticated;
GRANT ALL ON public.drafts TO service_role;
ALTER TABLE public.drafts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "drafts owner" ON public.drafts FOR ALL
  TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE TABLE public.dm_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  user_b UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  last_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_a, user_b)
);
GRANT SELECT, INSERT, UPDATE ON public.dm_threads TO authenticated;
GRANT ALL ON public.dm_threads TO service_role;
ALTER TABLE public.dm_threads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "dm_threads participant read" ON public.dm_threads FOR SELECT
  TO authenticated USING (user_a = auth.uid() OR user_b = auth.uid());
CREATE POLICY "dm_threads participant insert" ON public.dm_threads FOR INSERT
  TO authenticated WITH CHECK (user_a = auth.uid() OR user_b = auth.uid());
CREATE POLICY "dm_threads participant update" ON public.dm_threads FOR UPDATE
  TO authenticated USING (user_a = auth.uid() OR user_b = auth.uid());

CREATE TABLE public.dms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES public.dm_threads(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at TIMESTAMPTZ,
  deleted BOOLEAN NOT NULL DEFAULT false,
  seen_at TIMESTAMPTZ
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dms TO authenticated;
GRANT ALL ON public.dms TO service_role;
ALTER TABLE public.dms ENABLE ROW LEVEL SECURITY;
CREATE POLICY "dms participant read" ON public.dms FOR SELECT
  TO authenticated USING (sender_id = auth.uid() OR recipient_id = auth.uid());
CREATE POLICY "dms sender insert" ON public.dms FOR INSERT
  TO authenticated WITH CHECK (sender_id = auth.uid());
CREATE POLICY "dms sender update" ON public.dms FOR UPDATE
  TO authenticated USING (sender_id = auth.uid()) WITH CHECK (sender_id = auth.uid());
CREATE POLICY "dms recipient seen update" ON public.dms FOR UPDATE
  TO authenticated USING (recipient_id = auth.uid());

CREATE INDEX dms_thread_created_idx ON public.dms (thread_id, created_at DESC);
CREATE INDEX dms_recipient_unread_idx ON public.dms (recipient_id) WHERE seen_at IS NULL;

CREATE TABLE public.dm_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dm_id UUID NOT NULL REFERENCES public.dms(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  storage_path TEXT NOT NULL
);
GRANT SELECT, INSERT, DELETE ON public.dm_attachments TO authenticated;
GRANT ALL ON public.dm_attachments TO service_role;
ALTER TABLE public.dm_attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "dm_attachments participant" ON public.dm_attachments FOR ALL
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.dms d WHERE d.id = dm_attachments.dm_id AND (d.sender_id = auth.uid() OR d.recipient_id = auth.uid())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.dms d WHERE d.id = dm_attachments.dm_id AND d.sender_id = auth.uid()
  ));

CREATE TABLE public.settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.settings TO authenticated;
GRANT ALL ON public.settings TO service_role;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "settings admin read" ON public.settings FOR SELECT
  TO authenticated USING (public.has_role(auth.uid(), 'admin'::app_role));

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

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE c.relkind='r' AND n.nspname='public' LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t.relname);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t.relname);
  END LOOP;
END $$;
