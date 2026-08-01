import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  Archive,
  ArrowLeft,
  ArrowUpRight,
  Ban,
  ChevronDown,
  Download,
  Inbox,
  MailOpen,
  Paperclip,
  Reply,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/confirm-action";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { createIsolatedEmailDocument, normalizeEmailContentId } from "@/lib/email-html";
import { extractSenderEmail, senderDomain } from "@/lib/mail-sender";

type MessageAttachment = {
  id: string;
  filename: string;
  mime: string | null;
  size: number;
  content_base64: string | null;
  content_id: string | null;
  content_disposition: string | null;
};

const FOLDER_LABELS: Record<string, string> = {
  inbox: "Réception",
  sent: "Envoyés",
  archive: "Archives",
  trash: "Corbeille",
  spam: "Indésirables",
};

const INLINE_IMAGE_MIMES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_INLINE_IMAGES_BYTES = 10 * 1024 * 1024;

function buildInlineImageMap(attachments: MessageAttachment[]): ReadonlyMap<string, string> {
  const images = new Map<string, string>();
  let totalBytes = 0;
  for (const attachment of attachments) {
    const mime = (attachment.mime || "").split(";", 1)[0].trim().toLowerCase();
    const content = attachment.content_base64 || "";
    const contentId = attachment.content_id ? normalizeEmailContentId(attachment.content_id) : "";
    if (!contentId || !INLINE_IMAGE_MIMES.has(mime) || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) {
      continue;
    }
    const estimatedBytes = Math.floor((content.length * 3) / 4);
    if (
      estimatedBytes <= 0 ||
      estimatedBytes > MAX_INLINE_IMAGE_BYTES ||
      totalBytes + estimatedBytes > MAX_INLINE_IMAGES_BYTES
    ) {
      continue;
    }
    totalBytes += estimatedBytes;
    images.set(contentId, `data:${mime};base64,${content}`);
  }
  return images;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Kio`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mio`;
}

function downloadAttachment(attachment: MessageAttachment) {
  if (!attachment.content_base64) {
    toast.error("Le contenu de cette pièce jointe n’est plus disponible");
    return;
  }
  try {
    const binary = atob(attachment.content_base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const url = URL.createObjectURL(
      new Blob([bytes], { type: attachment.mime || "application/octet-stream" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = attachment.filename || "piece-jointe";
    anchor.rel = "noopener";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  } catch {
    toast.error("Cette pièce jointe semble endommagée");
  }
}

function displayRawMessage(raw: string | null): string {
  if (!raw) return "(source originale indisponible)";
  if (!raw.startsWith("base64:")) return raw;
  try {
    const binary = atob(raw.slice("base64:".length));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "(la source enregistrée est endommagée)";
  }
}

function replyAddress(sender: string): string {
  const bracketed = sender.match(/<([^<>]+)>/);
  return (bracketed?.[1] || sender).trim();
}

export const Route = createFileRoute("/_authenticated/msg/$id")({
  head: () => ({
    meta: [
      { title: "Message — JorgardeMail" },
      { name: "description", content: "Lecture d’un e-mail." },
    ],
  }),
  component: MessageDetail,
});

function MessageDetail() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"text" | "html" | "raw">("html");
  const [showHeaders, setShowHeaders] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);

  const {
    data: message,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ["msg", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("messages")
        .select(
          "*, mailboxes(local_part, domains(name)), attachments(id, filename, mime, size, content_base64, content_id, content_disposition)",
        )
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  useEffect(() => {
    if (!message?.body_html && tab === "html") setTab("text");
  }, [message?.body_html, tab]);

  useEffect(() => {
    if (!message || message.seen) return;
    void supabase
      .from("messages")
      .update({ seen: true })
      .eq("id", id)
      .then(({ error }) => {
        if (error) {
          console.error("[message] impossible de marquer le message comme lu", error);
          return;
        }
        queryClient.setQueryData(["msg", id], { ...message, seen: true });
        void queryClient.invalidateQueries({ queryKey: ["mail-unread-by-mailbox"] });
      });
  }, [id, message, queryClient]);

  const inlineImages = useMemo(
    () => buildInlineImageMap((message?.attachments as MessageAttachment[] | undefined) ?? []),
    [message?.attachments],
  );

  const blockRule = useMutation({
    mutationFn: async ({
      matchType,
      matchValue,
      mailboxId,
    }: {
      matchType: "email" | "domain";
      matchValue: string;
      mailboxId: string | null;
    }) => {
      const { error } = await supabase.rpc("create_block_rule", {
        p_match_type: matchType,
        p_match_value: matchValue,
        p_mailbox_id: mailboxId,
      });
      if (error) throw error;
    },
    onSuccess: async () => {
      setBlockOpen(false);
      toast.success(
        "Règle de blocage ajoutée; les messages correspondants vont dans les indésirables",
      );
      await Promise.all([
        refetch(),
        queryClient.invalidateQueries({ queryKey: ["all-mail"] }),
        queryClient.invalidateQueries({ queryKey: ["mb-msgs"] }),
        queryClient.invalidateQueries({ queryKey: ["mail-unread-by-mailbox"] }),
        queryClient.invalidateQueries({ queryKey: ["blocked-senders"] }),
      ]);
    },
    onError: () => toast.error("Impossible d’ajouter cette règle de blocage"),
  });

  if (isLoading) {
    return (
      <div className="app-page app-page-reader">
        <div className="reader-surface grid min-h-[70dvh] place-items-center text-sm text-muted-foreground">
          Ouverture du message…
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="app-page app-page-reader">
        <div className="reader-surface grid min-h-[50dvh] place-items-center p-8 text-center">
          <div>
            <p className="text-sm text-muted-foreground">
              Impossible de charger ce message pour le moment.
            </p>
            <Button className="mt-4" variant="outline" onClick={() => void refetch()}>
              Réessayer
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!message) {
    return (
      <div className="app-page app-page-reader">
        <div className="reader-surface grid min-h-[50dvh] place-items-center text-center text-muted-foreground">
          Ce message est introuvable ou n’est plus disponible.
        </div>
      </div>
    );
  }

  const address = `${message.mailboxes?.local_part}@${message.mailboxes?.domains?.name}`;
  const isSent = message.folder === "sent";
  const archive = async () => {
    const { error } = await supabase.from("messages").update({ folder: "archive" }).eq("id", id);
    if (error) {
      toast.error("Impossible d’archiver ce message");
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ["mail-unread-by-mailbox"] });
    navigate({ to: "/all" });
  };
  const trash = async (permanent = false) => {
    let error: { message: string } | null;
    if (permanent) {
      ({ error } = await supabase.from("messages").delete().eq("id", id));
    } else {
      ({ error } = await supabase.from("messages").update({ folder: "trash" }).eq("id", id));
    }
    if (error) {
      toast.error(
        permanent
          ? "Impossible de supprimer ce message"
          : "Impossible de déplacer ce message dans la corbeille",
      );
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ["mail-unread-by-mailbox"] });
    navigate({ to: "/all" });
  };

  return (
    <div className="app-page app-page-reader">
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => navigate({ to: "/all" })}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-transparent px-3 text-sm text-muted-foreground hover:border-border hover:bg-card/60 hover:text-foreground"
        >
          <ArrowLeft size={15} /> Retour
        </button>
        <div className="ml-auto flex items-center gap-2">
          {!isSent && (
            <Button asChild size="sm">
              <Link
                to="/compose"
                search={{
                  to: replyAddress(message.sender),
                  subject: /^\s*re\s*:/i.test(message.subject || "")
                    ? message.subject || ""
                    : `Re: ${message.subject || "Sans objet"}`,
                  inReplyTo: message.message_id || undefined,
                }}
              >
                <Reply className="size-4" /> <span className="hidden sm:inline">Répondre</span>
              </Link>
            </Button>
          )}
          {message.folder !== "archive" && message.folder !== "trash" && (
            <Button variant="outline" size="sm" onClick={archive}>
              <Archive className="size-4" /> <span className="hidden sm:inline">Archiver</span>
            </Button>
          )}
          {!isSent && extractSenderEmail(message.sender) && (
            <Button variant="outline" size="sm" onClick={() => setBlockOpen(true)}>
              <Ban className="size-4" /> <span className="hidden sm:inline">Bloquer</span>
            </Button>
          )}
          {message.folder === "trash" ? (
            <ConfirmAction
              title="Supprimer définitivement ce message ?"
              description="Le message et ses pièces jointes seront détruits sans possibilité de restauration."
              confirmLabel="Supprimer définitivement"
              onConfirm={() => void trash(true)}
            >
              <Button variant="outline" size="sm" className="border-red-400/25 text-red-300">
                <Trash2 className="size-4" />
                <span className="hidden sm:inline">Supprimer</span>
              </Button>
            </ConfirmAction>
          ) : (
            <Button variant="outline" size="sm" onClick={() => void trash(false)}>
              <Trash2 className="size-4" />
              <span className="hidden sm:inline">Corbeille</span>
            </Button>
          )}
        </div>
      </div>

      <BlockSenderDialog
        open={blockOpen}
        onOpenChange={setBlockOpen}
        sender={message.sender}
        address={address}
        mailboxId={message.mailbox_id}
        pending={blockRule.isPending}
        onBlock={(matchType, matchValue, mailboxId) =>
          blockRule.mutate({ matchType, matchValue, mailboxId })
        }
      />

      <article className="reader-surface">
        <header className="px-5 py-6 sm:px-8 sm:py-8 lg:px-10">
          <div className="flex items-start gap-4 sm:gap-5">
            <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-brand/90 to-brand-secondary/70 text-sm font-bold text-white shadow-[0_16px_38px_-18px_var(--brand-secondary)] sm:size-13">
              {(message.sender || "?").trim()[0]?.toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="page-eyebrow mb-2 before:hidden">
                {isSent ? "Message envoyé" : "Message reçu"}
              </div>
              <h1 className="max-w-5xl font-display text-2xl leading-[1.08] text-white sm:text-4xl lg:text-[2.75rem]">
                {message.subject || "Sans objet"}
              </h1>
              <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
                <span className="font-semibold text-foreground">{message.sender}</span>
                <span className="text-muted-foreground">
                  {isSent ? `à ${message.recipient_addr}` : `vers ${address}`}
                </span>
                <span className="hidden text-muted-foreground sm:inline">·</span>
                <time className="text-muted-foreground">
                  {new Date(message.received_at).toLocaleString("fr-FR", {
                    dateStyle: "long",
                    timeStyle: "short",
                  })}
                </time>
              </div>
              <button
                type="button"
                onClick={() => setShowHeaders((value) => !value)}
                className="mt-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                {showHeaders ? "Masquer les détails" : "Afficher les détails"}
                <ChevronDown
                  className={`size-3.5 transition-transform ${showHeaders ? "rotate-180" : ""}`}
                />
              </button>
            </div>
            <div className="hidden size-11 place-items-center rounded-2xl border border-brand-secondary/15 bg-brand-secondary/6 text-brand-secondary sm:grid">
              <MailOpen className="size-5" />
            </div>
          </div>

          {showHeaders && (
            <dl className="mt-6 grid gap-3 rounded-2xl border border-border bg-black/15 p-4 text-xs sm:grid-cols-2">
              {[
                ["Identifiant", message.message_id || "—"],
                ["Réponse à", message.in_reply_to || "—"],
                ["Dossier", FOLDER_LABELS[message.folder] || message.folder],
                ["Taille", formatBytes(message.size_bytes)],
              ].map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="mt-1 truncate font-mono text-foreground" title={value}>
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </header>

        {message.attachments && message.attachments.length > 0 && (
          <div className="border-t border-border px-5 py-4 sm:px-8 lg:px-10">
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <Paperclip className="size-3.5" />
              {message.attachments.length} pièce{message.attachments.length > 1 ? "s" : ""} jointe
              {message.attachments.length > 1 ? "s" : ""}
            </div>
            <div className="flex flex-wrap gap-2">
              {message.attachments.map((attachment: MessageAttachment) => (
                <Button
                  key={attachment.id}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => downloadAttachment(attachment)}
                  title={attachment.mime || "Pièce jointe"}
                >
                  <Download className="size-3.5" />
                  <span className="max-w-64 truncate">{attachment.filename}</span>
                  <span className="text-muted-foreground">{formatBytes(attachment.size)}</span>
                </Button>
              ))}
            </div>
          </div>
        )}

        <div className="reader-toolbar flex flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
          <Tabs value={tab} onValueChange={(value) => setTab(value as typeof tab)}>
            <TabsList>
              <TabsTrigger value="html" disabled={!message.body_html}>
                Lecture
              </TabsTrigger>
              <TabsTrigger value="text">Texte</TabsTrigger>
              <TabsTrigger value="raw">Source</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="ml-auto text-xs text-muted-foreground">
            Les contenus distants sont bloqués pour votre sécurité.
          </div>
        </div>

        {tab === "html" && message.body_html && (
          <div className="reader-paper">
            <iframe
              title="Contenu HTML de l’e-mail"
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              referrerPolicy="no-referrer"
              srcDoc={createIsolatedEmailDocument(message.body_html, inlineImages)}
              className="reader-frame w-full border-0 bg-white"
            />
          </div>
        )}
        {tab === "text" && (
          <div className="reader-paper">
            <pre className="reader-text whitespace-pre-wrap font-sans">
              {message.body_text || "Aucune version texte n’est disponible pour ce message."}
            </pre>
          </div>
        )}
        {tab === "raw" && (
          <pre className="max-h-[70dvh] min-h-[32rem] overflow-auto bg-[#080b12] p-5 text-xs leading-6 text-slate-300 sm:p-8">
            {displayRawMessage(message.raw)}
          </pre>
        )}
      </article>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {["archive", "trash", "spam"].includes(message.folder) && (
          <Button
            variant="outline"
            onClick={async () => {
              const { error } = await supabase
                .from("messages")
                .update({ folder: "inbox" })
                .eq("id", id);
              if (error) {
                toast.error("Impossible de restaurer ce message");
                return;
              }
              await queryClient.invalidateQueries({ queryKey: ["mail-unread-by-mailbox"] });
              navigate({ to: "/all" });
            }}
          >
            <Inbox className="size-4" /> Remettre dans la boîte de réception
          </Button>
        )}
        <Link
          to="/m/$id"
          params={{ id: message.mailbox_id }}
          className="ml-auto inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-gold hover:bg-brand-secondary/5"
        >
          Ouvrir cette adresse <ArrowUpRight className="size-4" />
        </Link>
      </div>
    </div>
  );
}

function BlockSenderDialog({
  open,
  onOpenChange,
  sender,
  address,
  mailboxId,
  pending,
  onBlock,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sender: string;
  address: string;
  mailboxId: string;
  pending: boolean;
  onBlock: (matchType: "email" | "domain", matchValue: string, mailboxId: string | null) => void;
}) {
  const email = extractSenderEmail(sender);
  const domain = senderDomain(sender);
  if (!email || !domain) return null;

  const options = [
    {
      title: `Cette adresse · ${email}`,
      description: `Bloquer seulement pour ${address}`,
      matchType: "email" as const,
      matchValue: email,
      scope: mailboxId,
    },
    {
      title: `Tout le domaine · @${domain}`,
      description: `Bloquer ce domaine seulement pour ${address}`,
      matchType: "domain" as const,
      matchValue: domain,
      scope: mailboxId,
    },
    {
      title: `${email} sur toutes mes adresses`,
      description: "Appliquer à toutes les adresses actuelles et futures de votre compte",
      matchType: "email" as const,
      matchValue: email,
      scope: null,
    },
    {
      title: `@${domain} sur toutes mes adresses`,
      description: "Bloquer le domaine pour tout votre compte",
      matchType: "domain" as const,
      matchValue: domain,
      scope: null,
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl">Bloquer l’expéditeur</DialogTitle>
          <DialogDescription>
            Les e-mails correspondants déjà reçus et les prochains seront rangés dans les
            indésirables sans générer de notification.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {options.map((option) => (
            <button
              key={`${option.matchType}-${option.matchValue}-${option.scope ?? "all"}`}
              type="button"
              disabled={pending}
              className="w-full rounded-2xl border border-border bg-black/10 p-4 text-left transition-colors hover:border-red-300/25 hover:bg-red-300/[0.05] disabled:opacity-50"
              onClick={() => onBlock(option.matchType, option.matchValue, option.scope)}
            >
              <span className="block font-semibold text-foreground">{option.title}</span>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                {option.description}
              </span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
