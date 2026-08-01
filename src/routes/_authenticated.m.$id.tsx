import { createFileRoute } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/page-header";
import { Search } from "lucide-react";
import { MailMessageList } from "@/components/mail-message-list";

export const Route = createFileRoute("/_authenticated/m/$id")({
  head: () => ({
    meta: [
      { title: "Adresse — JorgardeMail" },
      { name: "description", content: "Messages reçus sur cette adresse." },
    ],
  }),
  component: MailboxView,
});

function MailboxView() {
  const { id } = Route.useParams();
  const { user } = useAuth();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);

  const { data: mb } = useQuery({
    queryKey: ["mb", user?.id, id],
    enabled: !!user,
    queryFn: async () =>
      (
        await supabase
          .from("mailboxes")
          .select("*, domain:domains(name)")
          .eq("id", id)
          .eq("user_id", user!.id)
          .maybeSingle()
      ).data,
  });

  const { data: msgs, isLoading: messagesLoading } = useQuery({
    queryKey: ["mb-msgs", user?.id, id, debounced],
    enabled: !!user && !!mb,
    queryFn: async () => {
      const search = debounced
        .replace(/[^\p{L}\p{N}@ .+-]/gu, " ")
        .trim()
        .slice(0, 100);
      let q2 = supabase
        .from("messages")
        .select("*")
        .eq("mailbox_id", id)
        .eq("folder", "inbox")
        .order("received_at", { ascending: false })
        .limit(200);
      if (search)
        q2 = q2.or(
          `subject.ilike.%${search}%,sender.ilike.%${search}%,body_text.ilike.%${search}%`,
        );
      return (await q2).data ?? [];
    },
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
  });

  const unread = (msgs ?? []).filter((m) => !m.seen).length;

  return (
    <div className="app-page">
      <PageHeader
        eyebrow="Adresse e-mail"
        title={
          <span className="break-all">
            {mb?.local_part}@{mb?.domain?.name}
          </span>
        }
        description={
          messagesLoading
            ? "Actualisation de cette adresse…"
            : `${msgs?.length ?? 0} message${(msgs?.length ?? 0) > 1 ? "s" : ""} · ${unread} non lu${unread > 1 ? "s" : ""}`
        }
      />
      <div className="noir-panel relative mb-4 rounded-2xl p-2.5">
        <Search className="pointer-events-none absolute left-6 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label="Rechercher dans cette adresse"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="Rechercher dans cette adresse…"
          className="bg-black/15 pl-10"
        />
      </div>
      <MailMessageList
        messages={msgs ?? []}
        loading={messagesLoading}
        folder="inbox"
        mailboxId={id}
        emptyText="Aucun message pour le moment."
      />
    </div>
  );
}
