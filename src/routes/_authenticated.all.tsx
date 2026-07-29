import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { ListSkeleton } from "@/components/list-skeleton";
import { formatDistanceToNowStrict } from "date-fns";
import { fr } from "date-fns/locale";
import { Inbox, Search } from "lucide-react";

const FOLDERS = ["inbox", "sent", "archive", "trash", "spam"] as const;
type Folder = (typeof FOLDERS)[number];
const FOLDER_LABELS: Record<Folder, string> = {
  inbox: "Réception",
  sent: "Envoyés",
  archive: "Archives",
  trash: "Corbeille",
  spam: "Indésirables",
};

export const Route = createFileRoute("/_authenticated/all")({
  head: () => ({
    meta: [
      { title: "Boîte de réception — JorgardeMail" },
      { name: "description", content: "Tous vos e-mails réunis au même endroit." },
    ],
  }),
  component: AllMail,
});

function AllMail() {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [folder, setFolder] = useState<Folder>("inbox");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);

  const { data, isLoading } = useQuery({
    queryKey: ["all-mail", folder, debounced],
    queryFn: async () => {
      const search = debounced
        .replace(/[^\p{L}\p{N}@ .+-]/gu, " ")
        .trim()
        .slice(0, 100);
      let query = supabase
        .from("messages")
        .select(
          "id, subject, sender, body_text, recipient_addr, received_at, seen, mailbox_id, mailboxes!inner(local_part, domains(name))",
        )
        .eq("folder", folder)
        .order("received_at", { ascending: false })
        .limit(100);
      if (search)
        query = query.or(
          `subject.ilike.%${search}%,sender.ilike.%${search}%,body_text.ilike.%${search}%`,
        );
      const { data } = await query;
      return data ?? [];
    },
    refetchInterval: 5_000,
  });

  const rows = useMemo(() => data ?? [], [data]);

  return (
    <div className="app-page">
      <PageHeader
        eyebrow="Votre messagerie"
        title="Boîte de réception"
        description={
          isLoading
            ? "Actualisation de vos messages…"
            : `${rows.length} message${rows.length === 1 ? "" : "s"} sur l’ensemble de vos adresses.`
        }
        actions={
          <div className="premium-badge normal-case tracking-normal">
            <Inbox className="size-3.5" /> Synchronisée
          </div>
        }
      />

      <div className="noir-panel mb-4 flex flex-col gap-3 rounded-2xl p-2.5 sm:flex-row">
        <div className="flex gap-2 overflow-x-auto">
          {FOLDERS.map((name) => (
            <Button
              key={name}
              type="button"
              size="sm"
              variant={folder === name ? "default" : "outline"}
              className={folder === name ? "bg-gold text-white" : ""}
              onClick={() => setFolder(name)}
            >
              {FOLDER_LABELS[name]}
            </Button>
          ))}
        </div>
        <div className="relative sm:ml-auto sm:w-full sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Rechercher dans les e-mails"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Rechercher un objet, un expéditeur…"
            className="border-border bg-black/15 pl-10"
          />
        </div>
      </div>

      <div className="noir-panel mail-list divide-y divide-border">
        {isLoading && <ListSkeleton />}
        {!isLoading && rows.length === 0 && (
          <div className="empty-state">
            <div>
              <Inbox className="mx-auto mb-4 size-8 text-brand-secondary/70" />
              {debounced
                ? "Aucun message ne correspond à votre recherche."
                : `Aucun message dans ${FOLDER_LABELS[folder].toLowerCase()}.`}
            </div>
          </div>
        )}
        {!isLoading &&
          rows.map((m, i) => {
            const addr = `${m.mailboxes?.local_part}@${m.mailboxes?.domains?.name}`;
            return (
              <Link
                key={m.id}
                to="/msg/$id"
                params={{ id: m.id }}
                className="mail-row cv-auto group flex items-center gap-4 px-5 py-3.5"
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
                  <span className="block truncate text-[0.94rem]">{m.subject || "Sans objet"}</span>
                  <span className="mt-1 block truncate text-xs text-muted-foreground">
                    {m.sender}
                    {m.body_text ? ` — ${m.body_text.replace(/\s+/g, " ").slice(0, 90)}` : ""}
                  </span>
                </span>
                <span className="hidden max-w-[220px] truncate rounded-full border border-brand-secondary/20 bg-brand-secondary/5 px-2.5 py-1 text-xs text-brand-secondary md:inline">
                  vers {addr}
                </span>
                <span className="text-xs text-muted-foreground w-16 text-right shrink-0">
                  {formatDistanceToNowStrict(new Date(m.received_at), {
                    addSuffix: false,
                    locale: fr,
                  })}
                </span>
              </Link>
            );
          })}
      </div>
    </div>
  );
}
