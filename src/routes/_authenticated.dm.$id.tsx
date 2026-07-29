import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { ArrowLeft, SendHorizontal } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/dm/$id")({
  head: () => ({
    meta: [
      { title: "Conversation — JorgardeMail" },
      { name: "description", content: "Conversation privée." },
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
    supabase.rpc("mark_dm_thread_seen", { p_thread_id: id }).then(() => {
      void queryClient.invalidateQueries({ queryKey: ["dm-unread", user.id] });
    });
  }, [id, user, thread, msgs?.length, queryClient]);

  useEffect(() => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    bottomRef.current?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
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
    return <div className="p-8 text-sm text-muted-foreground">Ouverture de la conversation…</div>;
  }
  if (!thread) {
    return (
      <div className="p-8 text-sm text-muted-foreground">
        Cette conversation est introuvable ou n’est plus accessible.
      </div>
    );
  }

  return (
    <div className="dm-thread flex h-[calc(100dvh-4rem)] flex-col md:h-screen">
      <div className="flex items-center gap-3 border-b border-border bg-background/55 p-4 backdrop-blur-xl sm:px-6">
        <button
          type="button"
          aria-label="Retour aux conversations"
          onClick={() => navigate({ to: "/dm" })}
          className="grid size-10 place-items-center rounded-xl border border-border bg-card/45 text-muted-foreground hover:border-primary/30 hover:text-foreground"
        >
          <ArrowLeft size={16} />
        </button>
        <div className="grid size-11 place-items-center rounded-xl bg-gradient-to-br from-brand/35 to-brand-secondary/20 font-display font-bold text-brand-secondary ring-1 ring-brand-secondary/15">
          {(thread?.other?.username ?? "?")[0]?.toUpperCase()}
        </div>
        <div className="min-w-0">
          <div className="font-medium truncate">@{thread?.other?.username}</div>
          <div className="text-xs text-muted-foreground">{thread?.other?.display_name}</div>
        </div>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-4 sm:p-6 lg:px-10 lg:py-8">
        {msgs?.length === 0 && (
          <div className="grid min-h-full place-items-center py-12 text-center text-sm text-muted-foreground">
            <div>
              <div className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl border border-border bg-card/50 font-display text-xl text-brand-secondary">
                {(thread.other?.username ?? "?")[0]?.toUpperCase()}
              </div>
              Commencez la conversation avec @{thread.other?.username}.
            </div>
          </div>
        )}
        {(msgs ?? []).map((m) => {
          const mine = m.sender_id === user!.id;
          return (
            <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"} jm-fade-up`}>
              <div
                className={`max-w-[82%] rounded-2xl px-4 py-2.5 text-sm shadow-lg sm:max-w-[70%] ${mine ? "bg-gradient-to-br from-brand to-primary text-white rounded-br-md" : "border border-border bg-card/80 text-foreground rounded-bl-md backdrop-blur"}`}
              >
                <div className="whitespace-pre-wrap">{m.body}</div>
                <div
                  className={`mt-1 text-[0.68rem] ${mine ? "text-white/65" : "text-muted-foreground"}`}
                >
                  {new Date(m.created_at).toLocaleTimeString("fr-FR", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                  {mine && m.seen_at && " · vu"}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <div className="flex items-end gap-2 border-t border-border bg-background/65 p-3 backdrop-blur-xl sm:p-4">
        <Textarea
          aria-label="Message"
          maxLength={10000}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), send())}
          placeholder="Écrire un message…"
          rows={1}
          className="max-h-40 min-h-11 resize-none py-3"
        />
        <Button
          type="button"
          size="icon"
          aria-label={sending ? "Envoi du message" : "Envoyer le message"}
          onClick={send}
          disabled={sending || !body.trim()}
          className="bg-gold shrink-0 text-white"
        >
          {sending ? (
            <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white motion-reduce:animate-none" />
          ) : (
            <SendHorizontal />
          )}
        </Button>
      </div>
    </div>
  );
}
