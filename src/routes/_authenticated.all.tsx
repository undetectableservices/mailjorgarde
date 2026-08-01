import { createFileRoute } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/page-header";
import { Inbox, Search } from "lucide-react";
import { MailMessageList } from "@/components/mail-message-list";

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
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
  });

  const rows = (data ?? []).map((message) => ({
    ...message,
    address: `${message.mailboxes?.local_part}@${message.mailboxes?.domains?.name}`,
  }));

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
        <div className="folder-switcher" role="group" aria-label="Dossier affiché">
          {FOLDERS.map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={folder === name}
              className={`folder-switcher-item ${folder === name ? "folder-switcher-item-active" : ""}`}
              onClick={() => setFolder(name)}
            >
              {FOLDER_LABELS[name]}
            </button>
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

      <MailMessageList
        messages={rows}
        loading={isLoading}
        folder={folder}
        emptyText={
          debounced
            ? "Aucun message ne correspond à votre recherche."
            : `Aucun message dans ${FOLDER_LABELS[folder].toLowerCase()}.`
        }
      />
    </div>
  );
}
