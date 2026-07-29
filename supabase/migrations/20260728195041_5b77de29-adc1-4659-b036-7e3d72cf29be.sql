
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
