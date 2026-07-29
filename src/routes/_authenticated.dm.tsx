import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { formatDistanceToNowStrict } from "date-fns";
import type { Database } from "@/integrations/supabase/types";

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

  const { data: threads } = useQuery({
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
    <div className="p-8 max-w-5xl mx-auto">
      <h1 className="font-display text-4xl text-gold mb-1">Direct messages</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Visible only to conversation participants in the app; not end-to-end encrypted. No SMTP, no
        email addresses — just @usernames.
      </p>

      <div className="noir-panel rounded-xl p-5 mb-6 relative">
        <div className="flex gap-2">
          <Input
            placeholder="@username"
            value={target}
            onChange={(e) => setTarget(e.target.value.replace(/^@/, ""))}
          />
          <Button
            onClick={() => start.mutate(target)}
            disabled={!target || start.isPending}
            className="bg-gold text-background hover:opacity-90"
          >
            Start
          </Button>
        </div>
        {suggestions.length > 0 && (
          <div className="mt-2 rounded-md border border-border bg-card divide-y divide-border">
            {suggestions.map((s) => (
              <button
                key={s.user_id}
                onClick={() => start.mutate(s.username)}
                className="w-full text-left px-3 py-2 hover:bg-accent text-sm"
              >
                @{s.username} <span className="text-muted-foreground">— {s.display_name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="noir-panel rounded-xl divide-y divide-border overflow-hidden">
        {(threads ?? []).length === 0 && (
          <div className="p-12 text-center text-muted-foreground">No conversations yet.</div>
        )}
        {(threads ?? []).map((t) => (
          <button
            key={t.id}
            onClick={() => navigate({ to: "/dm/$id", params: { id: t.id } })}
            className="w-full text-left px-5 py-3 hover:bg-accent flex items-center gap-3"
          >
            <div className="h-9 w-9 rounded-full bg-gold/20 text-gold flex items-center justify-center font-display">
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
