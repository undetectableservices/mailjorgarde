import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/page-header";
import { ListSkeleton } from "@/components/list-skeleton";
import { formatDistanceToNowStrict } from "date-fns";
import { fr } from "date-fns/locale";
import { Inbox, Search } from "lucide-react";

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
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);

  const { data: mb } = useQuery({
    queryKey: ["mb", id],
    queryFn: async () =>
      (
        await supabase
          .from("mailboxes")
          .select("*, domain:domains(name)")
          .eq("id", id)
          .maybeSingle()
      ).data,
  });

  const { data: msgs, isLoading: messagesLoading } = useQuery({
    queryKey: ["mb-msgs", id, debounced],
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
    refetchInterval: 5_000,
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
      <div className="noir-panel mail-list divide-y divide-border">
        {messagesLoading && <ListSkeleton />}
        {!messagesLoading && (msgs ?? []).length === 0 && (
          <div className="empty-state">
            <div>
              <Inbox className="mx-auto mb-4 size-8 text-brand-secondary/70" />
              Aucun message pour le moment.
            </div>
          </div>
        )}
        {!messagesLoading &&
          (msgs ?? []).map((m, i) => (
            <Link
              key={m.id}
              to="/msg/$id"
              params={{ id: m.id }}
              className="mail-row cv-auto flex items-center gap-4 px-5 py-3.5"
              style={{ animation: `jm-fade-up 420ms ease-out both ${Math.min(i, 8) * 26}ms` }}
            >
              <span className="relative grid size-10 shrink-0 place-items-center rounded-2xl border border-white/[0.06] bg-white/[0.035] text-xs font-bold text-muted-foreground">
                {(m.sender || "?").trim()[0]?.toUpperCase()}
                {!m.seen && (
                  <span className="signal-dot jm-pulse-gold absolute -right-0.5 -top-0.5 size-2 rounded-full" />
                )}
              </span>
              <span
                className={`flex-1 min-w-0 ${m.seen ? "text-muted-foreground" : "font-semibold"}`}
              >
                <span className="block truncate">{m.subject || "Sans objet"}</span>
                <span className="block text-xs text-muted-foreground truncate">{m.sender}</span>
              </span>
              <span className="text-xs text-muted-foreground w-16 text-right">
                {formatDistanceToNowStrict(new Date(m.received_at), { locale: fr })}
              </span>
            </Link>
          ))}
      </div>
    </div>
  );
}
