import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { formatDistanceToNowStrict } from "date-fns";

const FOLDERS = ["inbox", "archive", "trash", "spam"] as const;
type Folder = (typeof FOLDERS)[number];

export const Route = createFileRoute("/_authenticated/all")({
  head: () => ({
    meta: [
      { title: "All mail — JorgardeMail" },
      { name: "description", content: "Every message across every mailbox you own." },
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

  const { data } = useQuery({
    queryKey: ["all-mail", folder, debounced],
    queryFn: async () => {
      const search = debounced
        .replace(/[^\p{L}\p{N}@ .+-]/gu, " ")
        .trim()
        .slice(0, 100);
      let query = supabase
        .from("messages")
        .select(
          "id, subject, sender, recipient_addr, received_at, seen, mailbox_id, mailboxes!inner(local_part, domains(name))",
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
    <div className="p-8 max-w-5xl mx-auto">
      <div className="flex items-baseline justify-between mb-6">
        <div>
          <h1 className="font-display text-4xl text-gold">All mail</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {rows.length} message{rows.length === 1 ? "" : "s"} across every address you own.
          </p>
        </div>
      </div>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row">
        <div className="flex gap-2 overflow-x-auto">
          {FOLDERS.map((name) => (
            <Button
              key={name}
              type="button"
              size="sm"
              variant={folder === name ? "default" : "outline"}
              className={folder === name ? "bg-gold capitalize text-background" : "capitalize"}
              onClick={() => setFolder(name)}
            >
              {name}
            </Button>
          ))}
        </div>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search subject, sender, body…"
          className="bg-card border-border sm:ml-auto sm:max-w-sm"
        />
      </div>

      <div className="noir-panel rounded-xl divide-y divide-border overflow-hidden">
        {rows.length === 0 && (
          <div className="p-12 text-center text-muted-foreground">
            {debounced ? "No messages match your search." : `No messages in ${folder}.`}
          </div>
        )}
        {rows.map((m, i) => {
          const addr = `${m.mailboxes?.local_part}@${m.mailboxes?.domains?.name}`;
          return (
            <Link
              key={m.id}
              to="/msg/$id"
              params={{ id: m.id }}
              className="cv-auto flex items-center gap-4 px-5 py-3 hover:bg-accent transition-colors group"
              style={{ animation: `jm-fade-up 260ms ease-out both ${Math.min(i, 20) * 12}ms` }}
            >
              <span
                className={`h-2 w-2 rounded-full ${m.seen ? "bg-transparent" : "bg-gold jm-pulse-gold"}`}
              />
              <span
                className={`flex-1 min-w-0 ${m.seen ? "text-muted-foreground" : "font-semibold"}`}
              >
                <span className="block truncate">{m.subject || "(no subject)"}</span>
                <span className="block text-xs text-muted-foreground truncate">{m.sender}</span>
              </span>
              <span className="hidden md:inline text-[11px] rounded-full border border-gold/40 text-gold/90 px-2 py-0.5 truncate max-w-[220px]">
                to {addr}
              </span>
              <span className="text-xs text-muted-foreground w-16 text-right shrink-0">
                {formatDistanceToNowStrict(new Date(m.received_at), { addSuffix: false })}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
