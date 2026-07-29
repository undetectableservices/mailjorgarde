import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { formatDistanceToNowStrict } from "date-fns";

export const Route = createFileRoute("/_authenticated/m/$id")({
  head: () => ({
    meta: [
      { title: "Mailbox — JorgardeMail" },
      { name: "description", content: "Messages in this mailbox." },
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

  const { data: msgs } = useQuery({
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
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="font-display text-4xl text-gold">
          {mb?.local_part}@{mb?.domain?.name}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {msgs?.length ?? 0} messages · {unread} unread
        </p>
      </div>
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search…"
        className="mb-4 bg-card"
      />
      <div className="noir-panel rounded-xl divide-y divide-border overflow-hidden">
        {(msgs ?? []).length === 0 && (
          <div className="p-12 text-center text-muted-foreground">No messages.</div>
        )}
        {(msgs ?? []).map((m, i) => (
          <Link
            key={m.id}
            to="/msg/$id"
            params={{ id: m.id }}
            className="cv-auto flex items-center gap-4 px-5 py-3 hover:bg-accent"
            style={{ animation: `jm-fade-up 260ms ease-out both ${Math.min(i, 20) * 12}ms` }}
          >
            <span className={`h-2 w-2 rounded-full ${m.seen ? "bg-transparent" : "bg-gold"}`} />
            <span
              className={`flex-1 min-w-0 ${m.seen ? "text-muted-foreground" : "font-semibold"}`}
            >
              <span className="block truncate">{m.subject || "(no subject)"}</span>
              <span className="block text-xs text-muted-foreground truncate">{m.sender}</span>
            </span>
            <span className="text-xs text-muted-foreground w-16 text-right">
              {formatDistanceToNowStrict(new Date(m.received_at))}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
