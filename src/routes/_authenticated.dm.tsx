import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { ListSkeleton } from "@/components/list-skeleton";
import { toast } from "sonner";
import { formatDistanceToNowStrict } from "date-fns";
import type { Database } from "@/integrations/supabase/types";
import { ArrowUpRight, MessageCircleMore, Search } from "lucide-react";

type DmSuggestion = Database["public"]["Functions"]["search_dm_profiles"]["Returns"][number];

function errorMessage(error: unknown, fallback: string): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return fallback;
}

export const Route = createFileRoute("/_authenticated/dm")({
  head: () => ({
    meta: [
      { title: "Direct messages — JorgardeMail" },
      { name: "description", content: "Private @username messaging inside JorgardeMail." },
    ],
  }),
  component: DMPage,
});

function DMPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [target, setTarget] = useState("");
  const [suggestions, setSuggestions] = useState<DmSuggestion[]>([]);

  const { data: threads, isLoading: threadsLoading } = useQuery({
    queryKey: ["dm-threads", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data: ts, error: threadError } = await supabase
        .from("dm_threads")
        .select("*")
        .or(`user_a.eq.${user!.id},user_b.eq.${user!.id}`)
        .order("last_at", { ascending: false });
      if (threadError) throw threadError;
      if (!ts?.length) return [];
      const otherIds = ts.map((t) => (t.user_a === user!.id ? t.user_b : t.user_a));
      const { data: profs, error: profileError } = await supabase
        .from("profiles")
        .select("user_id, username, display_name")
        .in("user_id", otherIds);
      if (profileError) throw profileError;
      const byId = new Map((profs ?? []).map((p) => [p.user_id, p]));
      return ts.map((t) => ({
        ...t,
        other: byId.get(t.user_a === user!.id ? t.user_b : t.user_a),
      }));
    },
    refetchInterval: 5000,
  });

  useEffect(() => {
    if (target.length < 2) {
      setSuggestions([]);
      return;
    }
    let active = true;
    const t = setTimeout(async () => {
      const { data, error } = await supabase.rpc("search_dm_profiles", {
        p_query: target,
        p_limit: 6,
      });
      if (active) setSuggestions(error ? [] : (data ?? []));
    }, 150);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [target, user]);

  const start = useMutation({
    mutationFn: async (username: string) => {
      const normalized = username.trim().replace(/^@/, "").toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{1,22}[a-z0-9]$/.test(normalized)) {
        throw new Error("Enter a valid username");
      }
      const { data: tid, error } = await supabase.rpc("start_dm_thread", {
        p_username: normalized,
      });
      if (error) throw error;
      return tid;
    },
    onSuccess: (tid) => navigate({ to: "/dm/$id", params: { id: tid } }),
    onError: (error) => toast.error(errorMessage(error, "Could not start the conversation")),
  });

  return (
    <div className="app-page">
      <PageHeader
        eyebrow="Local channel"
        title="Direct messages"
        description="Visible only to conversation participants in the app; not end-to-end encrypted. No SMTP or email addresses — just local @usernames."
        actions={
          <div className="premium-badge normal-case tracking-normal">
            <MessageCircleMore className="size-3.5" /> Private node
          </div>
        }
      />

      <div className="noir-panel relative mb-6 rounded-2xl p-4 sm:p-5">
        <div className="mb-3 text-sm font-semibold text-foreground">Start a conversation</div>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Find local user"
              placeholder="Find @username"
              value={target}
              onChange={(event) => setTarget(event.target.value.replace(/^@/, ""))}
              className="pl-10"
            />
          </div>
          <Button
            onClick={() => start.mutate(target)}
            disabled={!target || start.isPending}
            className="bg-gold text-white"
          >
            Start <ArrowUpRight />
          </Button>
        </div>
        {suggestions.length > 0 && (
          <div className="mt-2 divide-y divide-border overflow-hidden rounded-xl border border-border bg-popover/95 shadow-2xl backdrop-blur-xl">
            {suggestions.map((s) => (
              <button
                key={s.user_id}
                onClick={() => start.mutate(s.username)}
                className="w-full px-3.5 py-3 text-left text-sm hover:bg-accent"
              >
                @{s.username} <span className="text-muted-foreground">— {s.display_name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="noir-panel mail-list divide-y divide-border">
        {threadsLoading && <ListSkeleton rows={4} />}
        {!threadsLoading && (threads ?? []).length === 0 && (
          <div className="empty-state">
            <div>
              <MessageCircleMore className="mx-auto mb-4 size-8 text-brand-secondary/70" />
              No conversations yet.
            </div>
          </div>
        )}
        {!threadsLoading &&
          (threads ?? []).map((t) => (
            <button
              key={t.id}
              onClick={() => navigate({ to: "/dm/$id", params: { id: t.id } })}
              className="mail-row flex w-full items-center gap-3 px-5 py-3.5 text-left"
            >
              <div className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-brand/25 to-brand-secondary/15 font-display font-bold text-brand-secondary ring-1 ring-brand-secondary/15">
                {(t.other?.username ?? "?")[0]?.toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">@{t.other?.username}</div>
                <div className="text-xs text-muted-foreground">{t.other?.display_name}</div>
              </div>
              <div className="text-xs text-muted-foreground">
                {formatDistanceToNowStrict(new Date(t.last_at), { addSuffix: true })}
              </div>
            </button>
          ))}
      </div>
    </div>
  );
}
