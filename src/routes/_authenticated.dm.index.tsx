import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { formatDistanceToNowStrict } from "date-fns";
import { fr } from "date-fns/locale";
import { ArrowUpRight, MessageCircleMore, Search, UsersRound } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { ListSkeleton } from "@/components/list-skeleton";
import { PageHeader } from "@/components/page-header";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { useAuth } from "@/lib/auth";

type DmProfile = Database["public"]["Functions"]["list_dm_profiles"]["Returns"][number];

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

export const Route = createFileRoute("/_authenticated/dm/")({
  head: () => ({
    meta: [
      { title: "Messages privés — JorgardeMail" },
      { name: "description", content: "Messagerie privée entre membres de JorgardeMail." },
    ],
  }),
  component: DMPage,
});

function DMPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");

  const {
    data: directory,
    isLoading: directoryLoading,
    isError: directoryError,
    refetch: refetchDirectory,
  } = useQuery({
    queryKey: ["dm-directory", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_dm_profiles", {});
      if (error) throw error;
      // The RPC already excludes the caller; keep this client-side guard so a
      // stale PostgREST schema can never render a self-conversation target.
      return (data ?? []).filter((profile) => profile.user_id !== user!.id);
    },
    staleTime: 30_000,
  });

  const visibleProfiles = useMemo(() => {
    const query = search.trim().replace(/^@/, "").toLocaleLowerCase("fr");
    if (!query) return directory ?? [];
    return (directory ?? []).filter(
      (profile) =>
        profile.username.toLocaleLowerCase("fr").includes(query) ||
        profile.display_name?.toLocaleLowerCase("fr").includes(query),
    );
  }, [directory, search]);

  const {
    data: threads,
    isLoading: threadsLoading,
    isError: threadsError,
    refetch: refetchThreads,
  } = useQuery({
    queryKey: ["dm-threads", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data: threads, error: threadError } = await supabase
        .from("dm_threads")
        .select("*")
        .or(`user_a.eq.${user!.id},user_b.eq.${user!.id}`)
        .order("last_at", { ascending: false });
      if (threadError) throw threadError;
      if (!threads?.length) return [];

      const otherIds = threads.map((thread) =>
        thread.user_a === user!.id ? thread.user_b : thread.user_a,
      );
      const { data: profiles, error: profileError } = await supabase
        .from("profiles")
        .select("user_id, username, display_name")
        .in("user_id", otherIds);
      if (profileError) throw profileError;

      const { data: unreadRows, error: unreadError } = await supabase
        .from("dms")
        .select("thread_id")
        .eq("recipient_id", user!.id)
        .is("seen_at", null);
      if (unreadError) throw unreadError;
      const unreadByThread = (unreadRows ?? []).reduce<Record<string, number>>(
        (counts, message) => {
          counts[message.thread_id] = (counts[message.thread_id] ?? 0) + 1;
          return counts;
        },
        {},
      );

      const profilesById = new Map((profiles ?? []).map((profile) => [profile.user_id, profile]));
      return threads.map((thread) => ({
        ...thread,
        other: profilesById.get(thread.user_a === user!.id ? thread.user_b : thread.user_a),
        unread: unreadByThread[thread.id] ?? 0,
      }));
    },
    refetchInterval: 5000,
  });

  const start = useMutation({
    mutationFn: async (profile: DmProfile) => {
      if (profile.user_id === user?.id) throw new Error("Vous ne pouvez pas vous écrire");
      const { data: threadId, error } = await supabase.rpc("start_dm_thread_by_user", {
        p_user_id: profile.user_id,
      });
      if (error) throw error;
      return threadId;
    },
    onSuccess: (threadId) => {
      void navigate({ to: "/dm/$id", params: { id: threadId } });
    },
    onError: (error) => toast.error(errorMessage(error, "Impossible d’ouvrir cette conversation")),
  });

  return (
    <div className="app-page">
      <PageHeader
        eyebrow="Conversations"
        title="Messages privés"
        description="Retrouvez chaque membre de votre espace et démarrez une conversation en un clic."
        actions={
          <div className="premium-badge normal-case tracking-normal">
            <MessageCircleMore className="size-3.5" /> Messagerie instantanée
          </div>
        }
      />

      <section className="noir-panel relative mb-6 overflow-hidden rounded-3xl p-4 sm:p-6">
        <div className="mb-4 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Membres</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Sélectionnez une personne pour ouvrir une conversation.
            </p>
          </div>
          {!directoryLoading && (
            <div className="premium-badge normal-case tracking-normal">
              <UsersRound className="size-3.5" /> {directory?.length ?? 0}
            </div>
          )}
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Filtrer les membres"
            placeholder="Filtrer par nom ou identifiant"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="pl-10"
          />
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {directoryLoading && (
            <div className="col-span-full">
              <ListSkeleton rows={3} />
            </div>
          )}
          {directoryError && (
            <div className="col-span-full rounded-2xl border border-destructive/25 bg-destructive/8 px-4 py-5 text-center text-sm text-destructive-foreground">
              Impossible de charger les membres.{" "}
              <button className="font-semibold underline" onClick={() => void refetchDirectory()}>
                Réessayer
              </button>
            </div>
          )}
          {!directoryLoading && !directoryError && visibleProfiles.length === 0 && (
            <div className="col-span-full rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              {search ? "Aucun membre ne correspond à cette recherche." : "Aucun autre membre."}
            </div>
          )}
          {!directoryLoading &&
            visibleProfiles.map((profile) => (
              <button
                type="button"
                key={profile.user_id}
                disabled={start.isPending}
                onClick={() => start.mutate(profile)}
                className="group flex min-w-0 items-center gap-3 rounded-2xl border border-border/70 bg-card/45 p-3.5 text-left transition hover:-translate-y-0.5 hover:border-primary/35 hover:bg-accent disabled:pointer-events-none disabled:opacity-60 motion-reduce:transform-none"
              >
                <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-brand/25 to-brand-secondary/15 font-display font-bold text-brand-secondary ring-1 ring-brand-secondary/15">
                  {profile.username[0]?.toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">@{profile.username}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {profile.display_name || "Membre"}
                  </div>
                </div>
                <ArrowUpRight className="size-4 shrink-0 text-muted-foreground transition group-hover:text-primary" />
              </button>
            ))}
        </div>
      </section>

      <section className="noir-panel mail-list divide-y divide-border">
        <div className="px-5 py-4">
          <h2 className="text-sm font-semibold text-foreground">Conversations récentes</h2>
        </div>
        {threadsLoading && <ListSkeleton rows={4} />}
        {threadsError && (
          <div className="px-5 py-8 text-center text-sm text-muted-foreground">
            Impossible de charger les conversations.{" "}
            <button
              className="font-semibold text-primary underline"
              onClick={() => void refetchThreads()}
            >
              Réessayer
            </button>
          </div>
        )}
        {!threadsLoading && !threadsError && (threads ?? []).length === 0 && (
          <div className="empty-state">
            <div>
              <MessageCircleMore className="mx-auto mb-4 size-8 text-brand-secondary/70" />
              Aucune conversation pour le moment.
            </div>
          </div>
        )}

        {!threadsLoading &&
          !threadsError &&
          (threads ?? []).map((thread) => (
            <button
              type="button"
              key={thread.id}
              onClick={() => void navigate({ to: "/dm/$id", params: { id: thread.id } })}
              className="mail-row flex w-full items-center gap-3 px-5 py-3.5 text-left"
            >
              <div className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-brand/25 to-brand-secondary/15 font-display font-bold text-brand-secondary ring-1 ring-brand-secondary/15">
                {(thread.other?.username ?? "?")[0]?.toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">@{thread.other?.username}</div>
                <div className="text-xs text-muted-foreground">{thread.other?.display_name}</div>
              </div>
              {thread.unread > 0 && (
                <span className="grid min-w-6 place-items-center rounded-full bg-gradient-to-br from-brand to-brand-secondary px-1.5 py-0.5 text-[0.68rem] font-bold text-white shadow-[0_0_18px_color-mix(in_oklch,var(--brand-secondary),transparent_45%)]">
                  {thread.unread > 99 ? "99+" : thread.unread}
                </span>
              )}
              <div className="text-xs text-muted-foreground">
                {formatDistanceToNowStrict(new Date(thread.last_at), {
                  addSuffix: true,
                  locale: fr,
                })}
              </div>
            </button>
          ))}
      </section>
    </div>
  );
}
