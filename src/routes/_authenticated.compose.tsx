import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Check, ChevronDown, ChevronUp, FileText, Loader2, Send, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { getOutboundRelayInfo, sendOutboundEmail } from "@/lib/outbound-mail.functions";

const composeSearch = z.object({
  to: z.string().max(512).optional(),
  subject: z.string().max(998).optional(),
  from: z.string().uuid().optional(),
  inReplyTo: z
    .string()
    .max(998)
    .refine((value) => !/[\r\n]/.test(value))
    .optional(),
});

export const Route = createFileRoute("/_authenticated/compose")({
  validateSearch: composeSearch,
  head: () => ({
    meta: [
      { title: "Nouveau message — JorgardeMail" },
      { name: "description", content: "Rédigez et envoyez un e-mail." },
    ],
  }),
  component: ComposeMessage,
});

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function splitAddresses(value: string): string[] {
  return value
    .split(/[,;\n]+/)
    .map((address) => address.trim().toLowerCase())
    .filter(Boolean);
}

function createUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function ComposeMessage() {
  const preset = Route.useSearch();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const sendEmail = useServerFn(sendOutboundEmail);
  const relayInfo = useServerFn(getOutboundRelayInfo);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [mailboxId, setMailboxId] = useState(preset.from ?? "");
  const [to, setTo] = useState(preset.to ?? "");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState(preset.subject ?? "");
  const [body, setBody] = useState("");
  const [inReplyTo, setInReplyTo] = useState(preset.inReplyTo ?? "");
  const [showCopies, setShowCopies] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>(
    preset.to || preset.subject ? "dirty" : "idle",
  );
  const editRevision = useRef(0);
  const sendRequestId = useRef(createUuid());
  const sendAttempted = useRef(false);

  const { data: relay, isLoading: relayLoading } = useQuery({
    queryKey: ["outbound-relay-info"],
    queryFn: () => relayInfo(),
    staleTime: 60_000,
  });

  const { data: mailboxes = [], isLoading: mailboxesLoading } = useQuery({
    queryKey: ["outbound-mailboxes", user?.id],
    enabled: Boolean(user),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("mailboxes")
        .select("id, local_part, display_name, is_temp, expires_at, domain:domains(name)")
        .eq("user_id", user!.id)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []).filter(
        (mailbox) =>
          !mailbox.is_temp || (mailbox.expires_at && Date.parse(mailbox.expires_at) > Date.now()),
      );
    },
  });

  const { data: drafts = [] } = useQuery({
    queryKey: ["outbound-drafts", user?.id],
    enabled: Boolean(user),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("drafts")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(12);
      if (error) throw error;
      return data ?? [];
    },
  });

  useEffect(() => {
    if (!mailboxId && mailboxes[0]) setMailboxId(mailboxes[0].id);
  }, [mailboxId, mailboxes]);

  const hasContent = Boolean(to.trim() || cc.trim() || bcc.trim() || subject.trim() || body.trim());

  const saveDraft = useCallback(async () => {
    if (!user || !mailboxId || !hasContent) return;
    const savingRevision = editRevision.current;
    const id = draftId || createUuid();
    if (!draftId) setDraftId(id);
    setSaveState("saving");
    const { error } = await supabase.from("drafts").upsert({
      id,
      user_id: user.id,
      from_mailbox_id: mailboxId,
      to_addr: to.trim() || null,
      cc: cc.trim() || null,
      bcc: bcc.trim() || null,
      subject: subject.trim() || null,
      body: body || null,
      in_reply_to: inReplyTo || null,
      updated_at: new Date().toISOString(),
    });
    if (error) {
      setSaveState(editRevision.current === savingRevision ? "error" : "dirty");
      throw error;
    }
    setSaveState(editRevision.current === savingRevision ? "saved" : "dirty");
    await queryClient.invalidateQueries({ queryKey: ["outbound-drafts", user.id] });
  }, [bcc, body, cc, draftId, hasContent, inReplyTo, mailboxId, queryClient, subject, to, user]);

  useEffect(() => {
    if (saveState !== "dirty" || !hasContent || !mailboxId) return;
    const timer = window.setTimeout(() => {
      saveDraft().catch(() => undefined);
    }, 1_200);
    return () => window.clearTimeout(timer);
  }, [hasContent, mailboxId, saveDraft, saveState]);

  const markDirty = () => {
    editRevision.current += 1;
    if (sendAttempted.current) {
      sendRequestId.current = createUuid();
      sendAttempted.current = false;
    }
    setSaveState("dirty");
  };

  const resetComposer = () => {
    editRevision.current += 1;
    sendRequestId.current = createUuid();
    sendAttempted.current = false;
    setDraftId(null);
    setTo("");
    setCc("");
    setBcc("");
    setSubject("");
    setBody("");
    setInReplyTo("");
    setShowCopies(false);
    setSaveState("idle");
  };

  const loadDraft = (draft: (typeof drafts)[number]) => {
    editRevision.current += 1;
    sendRequestId.current = createUuid();
    sendAttempted.current = false;
    setDraftId(draft.id);
    setMailboxId(draft.from_mailbox_id || mailboxes[0]?.id || "");
    setTo(draft.to_addr || "");
    setCc(draft.cc || "");
    setBcc(draft.bcc || "");
    setSubject(draft.subject || "");
    setBody(draft.body || "");
    setInReplyTo(draft.in_reply_to || "");
    setShowCopies(Boolean(draft.cc || draft.bcc));
    setSaveState("saved");
  };

  const deleteDraft = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("drafts").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: async (_, id) => {
      if (draftId === id) resetComposer();
      await queryClient.invalidateQueries({ queryKey: ["outbound-drafts", user?.id] });
      toast.success("Brouillon supprimé");
    },
    onError: (error) => toast.error(errorMessage(error, "Impossible de supprimer le brouillon")),
  });

  const send = useMutation({
    mutationFn: async () => {
      if (!relay?.enabled || !relay.configured) {
        throw new Error("L'envoi externe n'est pas encore configuré par l'administrateur.");
      }
      if (!mailboxId) throw new Error("Choisissez une adresse d'envoi.");
      const recipients = {
        to: splitAddresses(to),
        cc: splitAddresses(cc),
        bcc: splitAddresses(bcc),
      };
      if (recipients.to.length === 0) throw new Error("Ajoutez au moins un destinataire.");
      sendAttempted.current = true;
      return sendEmail({
        data: {
          requestId: sendRequestId.current,
          mailboxId,
          ...recipients,
          subject,
          body,
          inReplyTo: inReplyTo || undefined,
        },
      });
    },
    onSuccess: async (result) => {
      if (draftId) await supabase.from("drafts").delete().eq("id", draftId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["outbound-drafts", user?.id] }),
        queryClient.invalidateQueries({ queryKey: ["all-mail"] }),
        queryClient.invalidateQueries({ queryKey: ["mb-msgs"] }),
      ]);
      if (result.rejected.length) {
        const rejectedList = result.rejected.slice(0, 8).join(", ");
        toast.warning(
          `Message envoyé, mais ${result.rejected.length} destinataire(s) ont été refusés.`,
          {
            description: `${rejectedList}${result.rejected.length > 8 ? "…" : ""}`,
            duration: 15_000,
          },
        );
      } else if (!result.archived) {
        toast.warning(
          "Message envoyé, mais sa copie n'a pas pu être classée dans les éléments envoyés.",
        );
      } else {
        toast.success("Message envoyé");
      }
      resetComposer();
    },
    onError: (error) => {
      const message = errorMessage(error, "Impossible d'envoyer le message");
      const mayBeLostResponse =
        error instanceof TypeError ||
        /failed to fetch|network|load failed|remise est incertain/i.test(message);
      if (!mayBeLostResponse) {
        sendRequestId.current = createUuid();
        sendAttempted.current = false;
      }
      toast.error(message);
    },
  });

  const selectedAddress = useMemo(() => {
    const mailbox = mailboxes.find((entry) => entry.id === mailboxId);
    return mailbox?.domain?.name ? `${mailbox.local_part}@${mailbox.domain.name}` : "";
  }, [mailboxId, mailboxes]);

  return (
    <div className="app-page">
      <PageHeader
        eyebrow="Messagerie"
        title="Nouveau message"
        description="Rédigez votre message, choisissez votre adresse et envoyez-le avec une connexion sécurisée."
        actions={
          <Button variant="outline" onClick={resetComposer} disabled={send.isPending}>
            Nouveau
          </Button>
        }
      />

      {!relayLoading && (!relay?.enabled || !relay.configured) && (
        <section className="rounded-2xl border border-amber-400/25 bg-amber-400/8 px-4 py-3 text-sm text-amber-100">
          La rédaction et les brouillons sont disponibles. L'administrateur doit encore activer le
          relais SMTP pour envoyer vers Internet.
        </section>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <section
          className="noir-panel overflow-hidden rounded-3xl"
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !send.isPending) {
              event.preventDefault();
              send.mutate();
            }
          }}
        >
          <div className="space-y-4 border-b border-border/60 p-5 sm:p-7">
            <div className="space-y-2">
              <Label htmlFor="compose-from">De</Label>
              <Select
                value={mailboxId}
                onValueChange={(value) => {
                  setMailboxId(value);
                  markDirty();
                }}
                disabled={mailboxesLoading || mailboxes.length === 0}
              >
                <SelectTrigger id="compose-from">
                  <SelectValue placeholder="Choisissez une adresse" />
                </SelectTrigger>
                <SelectContent>
                  {mailboxes.map((mailbox) => (
                    <SelectItem key={mailbox.id} value={mailbox.id}>
                      {mailbox.local_part}@{mailbox.domain?.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="compose-to">À</Label>
              <Input
                id="compose-to"
                type="text"
                inputMode="email"
                autoComplete="off"
                value={to}
                onChange={(event) => {
                  setTo(event.target.value);
                  markDirty();
                }}
                placeholder="destinataire@exemple.fr"
              />
              <p className="text-xs text-muted-foreground">
                Séparez plusieurs adresses avec une virgule. Maximum {relay?.maxRecipients ?? 25}
                destinataires au total.
              </p>
            </div>

            <button
              type="button"
              className="inline-flex items-center gap-2 text-xs font-semibold text-primary transition-colors hover:text-primary/80"
              onClick={() => setShowCopies((value) => !value)}
            >
              {showCopies ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
              {showCopies ? "Masquer les copies" : "Ajouter Cc et Cci"}
            </button>

            {showCopies && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="compose-cc">Cc</Label>
                  <Input
                    id="compose-cc"
                    inputMode="email"
                    value={cc}
                    onChange={(event) => {
                      setCc(event.target.value);
                      markDirty();
                    }}
                    placeholder="copie@exemple.fr"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="compose-bcc">Cci</Label>
                  <Input
                    id="compose-bcc"
                    inputMode="email"
                    value={bcc}
                    onChange={(event) => {
                      setBcc(event.target.value);
                      markDirty();
                    }}
                    placeholder="copie-cachee@exemple.fr"
                  />
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="compose-subject">Objet</Label>
              <Input
                id="compose-subject"
                value={subject}
                onChange={(event) => {
                  setSubject(event.target.value);
                  markDirty();
                }}
                maxLength={998}
                placeholder="Objet du message"
              />
            </div>
          </div>

          <div className="p-5 sm:p-7">
            <Label htmlFor="compose-body" className="sr-only">
              Message
            </Label>
            <Textarea
              id="compose-body"
              value={body}
              onChange={(event) => {
                setBody(event.target.value);
                markDirty();
              }}
              maxLength={200_000}
              className="min-h-[24rem] resize-y border-0 bg-transparent px-0 text-[15px] leading-7 shadow-none focus-visible:ring-0"
              placeholder="Écrivez votre message…"
            />
          </div>

          <footer className="flex flex-col gap-3 border-t border-border/60 bg-background/20 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-7">
            <div
              className="flex items-center gap-2 text-xs text-muted-foreground"
              aria-live="polite"
            >
              {saveState === "saving" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {saveState === "saved" && <Check className="h-3.5 w-3.5 text-emerald-400" />}
              {saveState === "error" && (
                <span className="text-destructive">Brouillon non enregistré</span>
              )}
              {saveState === "dirty" && "Modifications en attente"}
              {saveState === "saving" && "Enregistrement…"}
              {saveState === "saved" && "Brouillon enregistré"}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                onClick={() =>
                  saveDraft().catch((error) =>
                    toast.error(errorMessage(error, "Échec de l'enregistrement")),
                  )
                }
                disabled={!hasContent || !mailboxId || saveState === "saving"}
              >
                <FileText className="h-4 w-4" />
                Enregistrer
              </Button>
              <Button
                onClick={() => send.mutate()}
                disabled={
                  send.isPending ||
                  !relay?.enabled ||
                  !relay.configured ||
                  !mailboxId ||
                  !body.trim()
                }
              >
                {send.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                {send.isPending ? "Envoi…" : "Envoyer"}
              </Button>
            </div>
          </footer>
        </section>

        <aside className="noir-panel h-fit rounded-3xl p-4 sm:p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-foreground">Brouillons récents</p>
              <p className="mt-1 text-xs text-muted-foreground">Enregistrés automatiquement</p>
            </div>
            <FileText className="h-4 w-4 text-primary" />
          </div>
          <div className="space-y-2">
            {drafts.map((draft) => (
              <div
                key={draft.id}
                className={`group flex items-center gap-2 rounded-2xl border p-2 transition-colors ${
                  draft.id === draftId
                    ? "border-primary/35 bg-primary/10"
                    : "border-transparent bg-white/[0.025] hover:border-border hover:bg-white/[0.045]"
                }`}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 p-1.5 text-left"
                  onClick={() => loadDraft(draft)}
                >
                  <span className="block truncate text-sm font-medium text-foreground">
                    {draft.subject || "Sans objet"}
                  </span>
                  <span className="mt-1 block truncate text-xs text-muted-foreground">
                    {draft.to_addr || "Aucun destinataire"}
                  </span>
                </button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 opacity-60 hover:opacity-100"
                  aria-label="Supprimer le brouillon"
                  onClick={() => deleteDraft.mutate(draft.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            {drafts.length === 0 && (
              <div className="rounded-2xl border border-dashed border-border p-5 text-center text-xs text-muted-foreground">
                Aucun brouillon pour le moment.
              </div>
            )}
          </div>
          {selectedAddress && (
            <p className="mt-4 border-t border-border/60 pt-4 text-xs leading-5 text-muted-foreground">
              L'adresse d'enveloppe utilisée sera{" "}
              <span className="text-foreground">{selectedAddress}</span>.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
