import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, ArrowUpRight, Download, MailOpen, Paperclip } from "lucide-react";
import { createIsolatedEmailDocument } from "@/lib/email-html";
import { toast } from "sonner";

type MessageAttachment = {
  id: string;
  filename: string;
  mime: string | null;
  size: number;
  content_base64: string | null;
  content_disposition: string | null;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function downloadAttachment(attachment: MessageAttachment) {
  if (!attachment.content_base64) {
    toast.error("Attachment content is unavailable for this older message");
    return;
  }
  try {
    const binary = atob(attachment.content_base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = attachment.filename || "attachment";
    anchor.rel = "noopener";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  } catch {
    toast.error("The stored attachment is corrupt");
  }
}

function displayRawMessage(raw: string | null): string {
  if (!raw) return "(raw source unavailable)";
  if (!raw.startsWith("base64:")) return raw;
  try {
    const binary = atob(raw.slice("base64:".length));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "(stored raw source is corrupt)";
  }
}

export const Route = createFileRoute("/_authenticated/msg/$id")({
  head: () => ({
    meta: [
      { title: "Message — JorgardeMail" },
      { name: "description", content: "Message detail." },
    ],
  }),
  component: MessageDetail,
});

function MessageDetail() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState<"text" | "html" | "raw">("text");
  const [showHeaders, setShowHeaders] = useState(false);

  const { data: m, refetch } = useQuery({
    queryKey: ["msg", id],
    queryFn: async () =>
      (
        await supabase
          .from("messages")
          .select(
            "*, mailboxes(local_part, domains(name)), attachments(id, filename, mime, size, content_base64, content_disposition)",
          )
          .eq("id", id)
          .maybeSingle()
      ).data,
  });

  useEffect(() => {
    if (m && !m.seen) {
      supabase
        .from("messages")
        .update({ seen: true })
        .eq("id", id)
        .then(() => refetch());
    }
  }, [m, id, refetch]);

  if (!m) return <div className="p-8 text-muted-foreground">Loading…</div>;
  const addr = `${m.mailboxes?.local_part}@${m.mailboxes?.domains?.name}`;

  return (
    <div className="app-page app-page-narrow">
      <button
        type="button"
        onClick={() => navigate({ to: "/all" })}
        className="mb-5 inline-flex min-h-10 items-center gap-2 rounded-xl border border-transparent px-2 text-sm text-muted-foreground hover:border-border hover:bg-card/45 hover:text-foreground"
      >
        <ArrowLeft size={14} /> Back
      </button>

      <div className="noir-panel mb-4 rounded-3xl p-6 sm:p-8">
        <div className="mb-5 flex items-center justify-between gap-4">
          <div className="page-eyebrow mb-0">Inbound message</div>
          <div className="grid size-10 place-items-center rounded-xl bg-primary/10 text-brand-secondary ring-1 ring-primary/15">
            <MailOpen className="size-5" />
          </div>
        </div>
        <h1 className="font-display text-3xl leading-tight sm:text-4xl">
          {m.subject || "(no subject)"}
        </h1>
        <div className="mt-3 flex flex-wrap gap-3 text-sm text-muted-foreground">
          <span>
            From <span className="text-foreground">{m.sender}</span>
          </span>
          <span>·</span>
          <span>{new Date(m.received_at).toLocaleString()}</span>
        </div>
        <div className="mt-5 inline-flex max-w-full rounded-full border border-brand-secondary/20 bg-brand-secondary/5 px-3 py-1 text-xs text-brand-secondary">
          <span className="truncate">to {addr}</span>
        </div>
      </div>

      {m.attachments && m.attachments.length > 0 && (
        <div className="noir-panel mb-4 rounded-2xl p-4">
          <div className="flex items-center gap-2 text-sm font-medium mb-3">
            <Paperclip size={15} />
            {m.attachments.length} attachment{m.attachments.length === 1 ? "" : "s"}
          </div>
          <div className="flex flex-wrap gap-2">
            {m.attachments.map((attachment: MessageAttachment) => (
              <Button
                key={attachment.id}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => downloadAttachment(attachment)}
                title={attachment.mime || "attachment"}
              >
                <Download size={13} />
                <span className="max-w-64 truncate">{attachment.filename}</span>
                <span className="text-muted-foreground">{formatBytes(attachment.size)}</span>
              </Button>
            ))}
          </div>
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Tabs value={tab} onValueChange={(value) => setTab(value as typeof tab)}>
          <TabsList>
            {(["text", "html", "raw"] as const).map((item) => (
              <TabsTrigger key={item} value={item} className="uppercase tracking-wider">
                {item}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <button
          type="button"
          onClick={() => setShowHeaders((v) => !v)}
          className="ml-auto min-h-10 rounded-xl px-3 text-xs text-muted-foreground hover:bg-card/50 hover:text-foreground"
        >
          {showHeaders ? "Hide" : "Show"} full headers
        </button>
      </div>

      {showHeaders && (
        <pre className="noir-panel mb-3 max-h-64 overflow-auto rounded-2xl p-4 text-xs">
          {JSON.stringify(
            {
              "Message-ID": m.message_id,
              "In-Reply-To": m.in_reply_to,
              Thread: m.thread_id,
              Folder: m.folder,
              Size: m.size_bytes,
              Received: m.received_at,
            },
            null,
            2,
          )}
        </pre>
      )}

      <div className="noir-panel min-h-[240px] rounded-2xl p-5 sm:p-6">
        {tab === "text" && (
          <pre className="whitespace-pre-wrap text-sm font-sans">
            {m.body_text || "(no plain text body)"}
          </pre>
        )}
        {tab === "html" &&
          (m.body_html ? (
            <iframe
              title="HTML email (remote content blocked)"
              sandbox=""
              referrerPolicy="no-referrer"
              srcDoc={createIsolatedEmailDocument(m.body_html)}
              className="w-full min-h-[400px] bg-white rounded"
            />
          ) : (
            <div className="text-muted-foreground">No HTML part.</div>
          ))}
        {tab === "raw" && (
          <pre className="text-xs overflow-auto max-h-[600px]">{displayRawMessage(m.raw)}</pre>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={async () => {
            await supabase.from("messages").update({ seen: !m.seen }).eq("id", id);
            refetch();
          }}
        >
          Mark as {m.seen ? "unread" : "read"}
        </Button>
        {m.folder !== "inbox" && (
          <Button
            variant="outline"
            onClick={async () => {
              await supabase.from("messages").update({ folder: "inbox" }).eq("id", id);
              navigate({ to: "/all" });
            }}
          >
            Restore to inbox
          </Button>
        )}
        {m.folder !== "archive" && m.folder !== "trash" && (
          <Button
            variant="outline"
            onClick={async () => {
              await supabase.from("messages").update({ folder: "archive" }).eq("id", id);
              navigate({ to: "/all" });
            }}
          >
            Archive
          </Button>
        )}
        {m.folder !== "trash" ? (
          <Button
            variant="outline"
            onClick={async () => {
              await supabase.from("messages").update({ folder: "trash" }).eq("id", id);
              navigate({ to: "/all" });
            }}
          >
            Move to trash
          </Button>
        ) : (
          <Button
            variant="outline"
            onClick={async () => {
              if (!window.confirm("Permanently delete this message? This cannot be undone."))
                return;
              await supabase.from("messages").delete().eq("id", id);
              navigate({ to: "/all" });
            }}
          >
            Delete permanently
          </Button>
        )}
        <Link
          to="/m/$id"
          params={{ id: m.mailbox_id }}
          className="ml-auto inline-flex min-h-11 items-center gap-2 self-center rounded-xl px-3 text-sm font-semibold text-gold hover:bg-brand-secondary/5"
        >
          Open mailbox <ArrowUpRight className="size-4" />
        </Link>
      </div>
    </div>
  );
}
