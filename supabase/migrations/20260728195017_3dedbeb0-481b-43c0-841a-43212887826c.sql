
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
