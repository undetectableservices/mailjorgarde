import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/dm/$id")({
  head: () => ({
    meta: [
      { title: "Conversation — JorgardeMail" },
      { name: "description", content: "Direct message conversation." },
    ],
  }),
  component: DMThread,
});

function DMThread() {
  const { id } = Route.useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const { data: thread, isLoading: threadLoading } = useQuery({
    queryKey: ["dm-thread", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("dm_threads")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const otherId = data.user_a === user!.id ? data.user_b : data.user_a;
      const { data: prof, error: profileError } = await supabase
        .from("profiles")
        .select("username, display_name")
        .eq("user_id", otherId)
        .maybeSingle();
      if (profileError) throw profileError;
      return { ...data, other: prof, otherId };
    },
    enabled: !!user,
  });

  const { data: msgs, refetch } = useQuery({
    queryKey: ["dm-msgs", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("dms")
        .select("*")
        .eq("thread_id", id)
        .order("created_at");
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!thread,
    refetchInterval: 2500,
  });

  useEffect(() => {
    if (!user || !thread) return;
    supabase.rpc("mark_dm_thread_seen", { p_thread_id: id }).then(() => {});
  }, [id, user, thread, msgs?.length]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs?.length]);

  const send = async () => {
    if (!body.trim() || !thread || sending) return;
    const text = body.trim();
    setBody("");
    setSending(true);
    const { error } = await supabase.rpc("send_dm", { p_thread_id: id, p_body: text });
    if (error) {
      toast.error(error.message);
      setBody(text);
      setSending(false);
      return;
    }
    await Promise.all([
      refetch(),
      queryClient.invalidateQueries({ queryKey: ["dm-threads", user!.id] }),
    ]);
    setSending(false);
  };

  if (threadLoading) {
    return <div className="p-8 text-sm text-muted-foreground">Loading conversation…</div>;
  }
  if (!thread) {
    return (
      <div className="p-8 text-sm text-muted-foreground">
        Conversation not found or you no longer have access.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen">
      <div className="p-4 border-b border-border flex items-center gap-3">
        <button
          onClick={() => navigate({ to: "/dm" })}
          className="text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={16} />
        </button>
        <div className="h-9 w-9 rounded-full bg-gold/20 text-gold flex items-center justify-center font-display">
          {(thread?.other?.username ?? "?")[0]?.toUpperCase()}
        </div>
        <div className="min-w-0">
          <div className="font-medium truncate">@{thread?.other?.username}</div>
          <div className="text-xs text-muted-foreground">{thread?.other?.display_name}</div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-2">
        {(msgs ?? []).map((m) => {
          const mine = m.sender_id === user!.id;
          return (
            <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"} jm-fade-up`}>
              <div
                className={`max-w-[70%] rounded-2xl px-4 py-2 text-sm ${mine ? "bg-gold text-background" : "bg-card border border-border"}`}
              >
                <div className="whitespace-pre-wrap">{m.body}</div>
                <div
                  className={`text-[10px] mt-1 ${mine ? "text-background/70" : "text-muted-foreground"}`}
                >
                  {new Date(m.created_at).toLocaleTimeString()}
                  {mine && m.seen_at && " · seen"}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <div className="p-4 border-t border-border flex gap-2">
        <Input
          maxLength={10000}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), send())}
          placeholder="Type a message…"
        />
        <Button
          onClick={send}
          disabled={sending || !body.trim()}
          className="bg-gold text-background"
        >
          {sending ? "Sending…" : "Send"}
        </Button>
      </div>
    </div>
  );
}
