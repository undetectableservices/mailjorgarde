import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Download, Paperclip } from "lucide-react";
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
    <div className="p-8 max-w-4xl mx-auto">
      <button
        onClick={() => navigate({ to: "/all" })}
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-4"
      >
        <ArrowLeft size={14} /> Back
      </button>

      <div className="noir-panel rounded-2xl p-8 mb-4 glow-gold">
        <div className="text-xs text-gold/80 uppercase tracking-widest mb-2">to {addr}</div>
        <h1 className="font-display text-3xl">{m.subject || "(no subject)"}</h1>
        <div className="mt-3 flex flex-wrap gap-3 text-sm text-muted-foreground">
          <span>
            From <span className="text-foreground">{m.sender}</span>
          </span>
          <span>·</span>
          <span>{new Date(m.received_at).toLocaleString()}</span>
        </div>
      </div>

      {m.attachments && m.attachments.length > 0 && (
        <div className="noir-panel rounded-xl p-4 mb-4">
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

      <div className="flex gap-2 mb-3">
        {(["text", "html", "raw"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`text-xs uppercase tracking-wider px-3 py-1 rounded-md border ${tab === t ? "border-gold text-gold" : "border-border text-muted-foreground hover:text-foreground"}`}
          >
            {t}
          </button>
        ))}
        <button
          onClick={() => setShowHeaders((v) => !v)}
          className="ml-auto text-xs text-muted-foreground hover:text-foreground"
        >
          {showHeaders ? "Hide" : "Show"} full headers
        </button>
      </div>

      {showHeaders && (
        <pre className="noir-panel rounded-xl p-4 text-xs overflow-auto max-h-64 mb-3">
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

      <div className="noir-panel rounded-xl p-6 min-h-[200px]">
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

      <div className="mt-4 flex gap-2">
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
          className="ml-auto text-sm text-gold self-center"
        >
          Open mailbox →
        </Link>
      </div>
    </div>
  );
}
