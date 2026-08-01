import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { formatDistanceToNowStrict } from "date-fns";
import { fr } from "date-fns/locale";
import { Archive, Check, CheckCheck, Inbox, MailCheck, ShieldAlert, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { ConfirmAction } from "@/components/confirm-action";
import { ListSkeleton } from "@/components/list-skeleton";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";

export type MailListMessage = {
  id: string;
  subject: string | null;
  sender: string;
  body_text?: string | null;
  received_at: string;
  seen: boolean;
  mailbox_id: string;
  address?: string;
};

type BulkAction = "read" | "archive" | "spam" | "trash" | "delete";

export function MailMessageList({
  messages,
  loading,
  folder,
  emptyText,
  mailboxId,
}: {
  messages: MailListMessage[];
  loading: boolean;
  folder: string;
  emptyText: string;
  mailboxId?: string;
}) {
  const queryClient = useQueryClient();
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const longPressTimer = useRef<number | null>(null);
  const longPressTriggered = useRef(false);
  const pressOrigin = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const available = new Set(messages.map((message) => message.id));
    setSelected((current) => new Set([...current].filter((id) => available.has(id))));
  }, [messages]);

  const refreshMail = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["all-mail"] }),
      queryClient.invalidateQueries({ queryKey: ["mb-msgs"] }),
      queryClient.invalidateQueries({ queryKey: ["mail-unread-by-mailbox"] }),
    ]);
  };

  const action = useMutation({
    mutationFn: async ({ kind, ids }: { kind: BulkAction; ids: string[] }) => {
      if (ids.length === 0) return 0;
      for (let offset = 0; offset < ids.length; offset += 75) {
        const chunk = ids.slice(offset, offset + 75);
        if (kind === "delete") {
          const { error } = await supabase.from("messages").delete().in("id", chunk);
          if (error) throw error;
        } else {
          const patch =
            kind === "read"
              ? { seen: true }
              : {
                  folder: kind === "trash" ? "trash" : kind === "spam" ? "spam" : "archive",
                };
          const { error } = await supabase.from("messages").update(patch).in("id", chunk);
          if (error) throw error;
        }
      }
      return ids.length;
    },
    onSuccess: async (count, variables) => {
      if (!count) return;
      const labels: Record<BulkAction, string> = {
        read: `${count} message${count > 1 ? "s" : ""} marqué${count > 1 ? "s" : ""} comme lu${count > 1 ? "s" : ""}`,
        archive: `${count} message${count > 1 ? "s archivés" : " archivé"}`,
        spam: `${count} message${count > 1 ? "s déplacés" : " déplacé"} dans les indésirables`,
        trash: `${count} message${count > 1 ? "s déplacés" : " déplacé"} dans la corbeille`,
        delete: `${count} message${count > 1 ? "s supprimés" : " supprimé"} définitivement`,
      };
      toast.success(labels[variables.kind]);
      setSelected(new Set());
      setSelectionMode(false);
      await refreshMail();
    },
    onError: () => toast.error("Impossible d’appliquer cette action aux messages"),
  });

  const readAll = useMutation({
    mutationFn: async () => {
      let query = supabase.from("messages").update({ seen: true }).eq("folder", "inbox");
      if (mailboxId) query = query.eq("mailbox_id", mailboxId);
      const { error } = await query;
      if (error) throw error;
    },
    onSuccess: async () => {
      toast.success(
        mailboxId
          ? "Tous les messages de cette adresse sont lus"
          : "Tous les messages de vos boîtes de réception sont lus",
      );
      await refreshMail();
    },
    onError: () => toast.error("Impossible de marquer tous les messages comme lus"),
  });

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const startLongPress = (id: string, button: number, x: number, y: number) => {
    if (button !== 0) return;
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
    longPressTriggered.current = false;
    pressOrigin.current = { x, y };
    longPressTimer.current = window.setTimeout(() => {
      longPressTriggered.current = true;
      setSelectionMode(true);
      setSelected((current) => new Set(current).add(id));
      navigator.vibrate?.(35);
    }, 480);
  };

  const cancelLongPress = () => {
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
    pressOrigin.current = null;
  };

  const moveLongPress = (x: number, y: number) => {
    if (!pressOrigin.current) return;
    if (Math.hypot(x - pressOrigin.current.x, y - pressOrigin.current.y) > 12) {
      cancelLongPress();
    }
  };

  const selectedIds = [...selected];
  const allSelected = messages.length > 0 && selected.size === messages.length;

  return (
    <div>
      {messages.length > 0 && (
        <div className="mail-action-bar mb-3 flex min-h-12 flex-wrap items-center gap-2 rounded-2xl border border-border bg-card/55 p-2 backdrop-blur-xl">
          {selectionMode ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSelectionMode(false);
                  setSelected(new Set());
                }}
              >
                <X className="size-4" /> Fermer
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  setSelected(
                    allSelected ? new Set() : new Set(messages.map((message) => message.id)),
                  )
                }
              >
                <CheckCheck className="size-4" />{" "}
                {allSelected ? "Tout désélectionner" : "Tout sélectionner"}
              </Button>
              <span className="mr-auto text-xs font-semibold text-brand-secondary">
                {selected.size} sélectionné{selected.size > 1 ? "s" : ""}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={!selected.size || action.isPending}
                onClick={() => action.mutate({ kind: "read", ids: selectedIds })}
              >
                <MailCheck className="size-4" /> Lire
              </Button>
              {folder !== "archive" && folder !== "trash" && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={!selected.size || action.isPending}
                  onClick={() => action.mutate({ kind: "archive", ids: selectedIds })}
                >
                  <Archive className="size-4" /> Archiver
                </Button>
              )}
              {folder !== "sent" && folder !== "spam" && folder !== "trash" && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={!selected.size || action.isPending}
                  onClick={() => action.mutate({ kind: "spam", ids: selectedIds })}
                >
                  <ShieldAlert className="size-4" /> Indésirables
                </Button>
              )}
              {folder !== "trash" && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={!selected.size || action.isPending}
                  onClick={() => action.mutate({ kind: "trash", ids: selectedIds })}
                >
                  <Trash2 className="size-4" /> Corbeille
                </Button>
              )}
              <ConfirmAction
                title={`Supprimer définitivement ${selected.size} message${selected.size > 1 ? "s" : ""} ?`}
                description="Les messages et leurs pièces jointes seront détruits sans possibilité de restauration."
                confirmLabel="Supprimer définitivement"
                onConfirm={() => action.mutate({ kind: "delete", ids: selectedIds })}
              >
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="border-red-400/25 text-red-300"
                  disabled={!selected.size || action.isPending}
                >
                  <Trash2 className="size-4" /> Supprimer définitivement
                </Button>
              </ConfirmAction>
            </>
          ) : (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setSelectionMode(true)}
              >
                <Check className="size-4" /> Sélectionner
              </Button>
              <span className="mr-auto hidden text-xs text-muted-foreground sm:inline">
                Appui long sur un message pour le sélectionner
              </span>
              {folder === "inbox" && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={readAll.isPending}
                  onClick={() => readAll.mutate()}
                >
                  <MailCheck className="size-4" /> Tout lire
                </Button>
              )}
            </>
          )}
        </div>
      )}

      <div className="noir-panel mail-list divide-y divide-border">
        {loading && <ListSkeleton />}
        {!loading && messages.length === 0 && (
          <div className="empty-state">
            <div>
              <Inbox className="mx-auto mb-4 size-8 text-brand-secondary/70" />
              {emptyText}
            </div>
          </div>
        )}
        {!loading &&
          messages.map((message) => {
            const checked = selected.has(message.id);
            return (
              <div
                key={message.id}
                className={`mail-row cv-auto group flex select-none items-center gap-3 px-3 py-3.5 sm:px-5 ${checked ? "mail-row-selected" : ""}`}
                onPointerDown={(event) =>
                  startLongPress(message.id, event.button, event.clientX, event.clientY)
                }
                onPointerUp={cancelLongPress}
                onPointerCancel={cancelLongPress}
                onPointerMove={(event) => moveLongPress(event.clientX, event.clientY)}
                onContextMenu={(event) => selectionMode && event.preventDefault()}
              >
                <button
                  type="button"
                  aria-label={checked ? "Désélectionner le message" : "Sélectionner le message"}
                  className={`grid size-7 shrink-0 place-items-center rounded-lg border transition-colors ${
                    selectionMode || checked
                      ? checked
                        ? "border-brand-secondary bg-brand-secondary text-slate-950"
                        : "border-border bg-black/15 text-transparent"
                      : "border-transparent text-transparent opacity-0 group-hover:opacity-100"
                  }`}
                  onClick={() => {
                    setSelectionMode(true);
                    toggle(message.id);
                  }}
                >
                  <Check className="size-4" />
                </button>
                <Link
                  to="/msg/$id"
                  params={{ id: message.id }}
                  className="flex min-w-0 flex-1 items-center gap-4"
                  onClick={(event) => {
                    if (selectionMode || longPressTriggered.current) {
                      event.preventDefault();
                      if (!longPressTriggered.current) toggle(message.id);
                      longPressTriggered.current = false;
                    }
                  }}
                >
                  <span className="relative grid size-10 shrink-0 place-items-center rounded-2xl border border-white/[0.06] bg-white/[0.035] text-xs font-bold text-muted-foreground">
                    {(message.sender || "?").trim()[0]?.toUpperCase()}
                    {!message.seen && (
                      <span className="signal-dot absolute -right-0.5 -top-0.5 size-2 rounded-full" />
                    )}
                  </span>
                  <span
                    className={`min-w-0 flex-1 ${message.seen ? "text-muted-foreground" : "font-semibold"}`}
                  >
                    <span className="block truncate text-[0.94rem]">
                      {message.subject || "Sans objet"}
                    </span>
                    <span className="mt-1 block truncate text-xs text-muted-foreground">
                      {message.sender}
                      {message.body_text
                        ? ` — ${message.body_text.replace(/\s+/g, " ").slice(0, 90)}`
                        : ""}
                    </span>
                  </span>
                  {message.address && (
                    <span className="hidden max-w-[220px] truncate rounded-full border border-brand-secondary/20 bg-brand-secondary/5 px-2.5 py-1 text-xs text-brand-secondary md:inline">
                      vers {message.address}
                    </span>
                  )}
                  <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">
                    {formatDistanceToNowStrict(new Date(message.received_at), {
                      addSuffix: false,
                      locale: fr,
                    })}
                  </span>
                </Link>
              </div>
            );
          })}
      </div>
    </div>
  );
}
