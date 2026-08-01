import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/page-header";
import { toast } from "sonner";
import {
  Ban,
  Clock3,
  KeyRound,
  Trash2,
  Megaphone,
  ShieldCheck,
  SlidersHorizontal,
  UserCheck,
} from "lucide-react";
import {
  broadcastToAllUsers,
  getAdminUserStats,
  setAdminMailboxLimit,
} from "@/lib/admin-broadcast.functions";
import { SetupWizard } from "@/components/setup-wizard";
import { AdminUserProvisioning, ResetUserPassword } from "@/components/admin-user-provisioning";
import { deleteUserMailbox, setLocalUserBan, setUserApiAccess } from "@/lib/admin-users.functions";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";

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

export const Route = createFileRoute("/_authenticated/admin")({
  head: () => ({
    meta: [
      { title: "Administration — JorgardeMail" },
      { name: "description", content: "Centre d’administration JorgardeMail." },
    ],
  }),
  component: AdminPage,
});

function AdminPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState<"setup" | "users" | "domains" | "broadcast">("setup");

  const { data: isAdmin, isLoading } = useQuery({
    queryKey: ["is-admin", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user!.id)
        .eq("role", "admin")
        .maybeSingle();
      return !!data;
    },
  });

  useEffect(() => {
    if (!isLoading && !isAdmin) navigate({ to: "/all" });
  }, [isAdmin, isLoading, navigate]);
  if (!isAdmin) return <div className="p-8 text-muted-foreground">Vérification des accès…</div>;

  return (
    <div className="app-page">
      <PageHeader
        eyebrow="Administration privée"
        title="Centre de contrôle"
        description="Configurez Jellyfin, le relais SMTP, les domaines, les diagnostics et les utilisateurs depuis un seul espace."
        actions={
          <div className="premium-badge normal-case tracking-normal">
            <ShieldCheck className="size-3.5" /> Administrateur
          </div>
        }
      />
      <Tabs value={tab} onValueChange={(value) => setTab(value as typeof tab)}>
        <TabsList className="grid h-auto w-full grid-cols-2 gap-1 p-1 sm:inline-grid sm:w-auto sm:grid-cols-4">
          {(["setup", "users", "domains", "broadcast"] as const).map((item) => (
            <TabsTrigger key={item} value={item} className="capitalize">
              {
                {
                  setup: "Contrôle",
                  users: "Utilisateurs",
                  domains: "Domaines",
                  broadcast: "Annonce",
                }[item]
              }
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="mt-6">
        {tab === "setup" && <SetupWizard />}
        {tab === "users" && <Users />}
        {tab === "domains" && <Domains />}
        {tab === "broadcast" && <Broadcast />}
      </div>
    </div>
  );
}

function Broadcast() {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const send = useServerFn(broadcastToAllUsers);
  const mut = useMutation({
    mutationFn: async () => send({ data: { subject, body } }),
    onSuccess: (r) => {
      toast.success(`Annonce distribuée à ${r.sent} utilisateur${r.sent === 1 ? "" : "s"}`);
      setSubject("");
      setBody("");
    },
    onError: (error) => toast.error(errorMessage(error, "L’annonce n’a pas pu être envoyée")),
  });

  return (
    <div className="noir-panel max-w-2xl space-y-4 rounded-3xl p-6 sm:p-7">
      <div className="flex items-center gap-3">
        <div className="grid size-10 place-items-center rounded-xl bg-primary/10 text-gold ring-1 ring-primary/15">
          <Megaphone size={18} />
        </div>
        <div>
          <h2 className="font-display text-2xl">Annoncer à tous les utilisateurs</h2>
          <p className="text-xs text-muted-foreground">
            Le message apparaîtra dans la boîte de réception de chaque utilisateur.
          </p>
        </div>
      </div>
      <Input placeholder="Objet" value={subject} onChange={(e) => setSubject(e.target.value)} />
      <Textarea
        placeholder="Rédigez votre annonce…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={8}
      />
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          Seuls les utilisateurs possédant au moins une adresse la recevront.
        </span>
        <Button
          onClick={() => mut.mutate()}
          disabled={!subject.trim() || !body.trim() || mut.isPending}
          className="bg-gold text-white"
        >
          {mut.isPending ? "Envoi…" : "Envoyer l’annonce"}
        </Button>
      </div>
    </div>
  );
}

function fmtBytes(n: number) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function Users() {
  const { user } = useAuth();
  const loadStats = useServerFn(getAdminUserStats);
  const updateLimit = useServerFn(setAdminMailboxLimit);
  const updateBan = useServerFn(setLocalUserBan);
  const updateApiAccess = useServerFn(setUserApiAccess);
  const removeMailbox = useServerFn(deleteUserMailbox);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const { data, refetch } = useQuery({
    queryKey: ["admin-users-stats"],
    queryFn: () => loadStats(),
  });

  const setLimit = useMutation({
    mutationFn: async ({ user_id, limit }: { user_id: string; limit: number }) => {
      await updateLimit({ data: { userId: user_id, limit } });
    },
    onSuccess: () => {
      toast.success("Limite mise à jour");
      refetch();
    },
    onError: (error) => toast.error(errorMessage(error, "Impossible de modifier la limite")),
  });

  const setBan = useMutation({
    mutationFn: async ({
      userId,
      duration,
    }: {
      userId: string;
      duration: "1h" | "24h" | "7d" | "permanent" | "none";
    }) => updateBan({ data: { userId, duration } }),
    onSuccess: (result) => {
      toast.success(result.banned ? "Utilisateur banni" : "Accès rétabli");
      void refetch();
    },
    onError: (error) =>
      toast.error(errorMessage(error, "Impossible de modifier l’accès de cet utilisateur")),
  });

  const setApiAccess = useMutation({
    mutationFn: ({ userId, enabled }: { userId: string; enabled: boolean }) =>
      updateApiAccess({ data: { userId, enabled } }),
    onSuccess: (result) => {
      toast.success(result.enabled ? "Accès API accordé" : "Accès API retiré et clés révoquées");
      void refetch();
    },
    onError: (error) => toast.error(errorMessage(error, "Impossible de modifier l’accès API")),
  });

  const deleteMailbox = useMutation({
    mutationFn: (mailboxId: string) => removeMailbox({ data: { mailboxId } }),
    onSuccess: (result) => {
      toast.success(`${result.address} supprimée`);
      void refetch();
    },
    onError: (error) => toast.error(errorMessage(error, "Impossible de supprimer cette adresse")),
  });

  const users = data?.users ?? [];

  return (
    <div className="space-y-4">
      <AdminUserProvisioning onCreated={() => void refetch()} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Utilisateurs" value={users.length.toString()} />
        <StatCard label="Adresses" value={(data?.totalBoxes ?? 0).toString()} />
        <StatCard label="Stockage" value={fmtBytes(data?.total ?? 0)} accent />
      </div>
      <div className="noir-panel mail-list divide-y divide-border">
        {users.map((u) => (
          <div key={u.user_id} className="mail-row flex flex-wrap items-center gap-4 p-4">
            <div className="flex-1 min-w-[220px]">
              <button
                type="button"
                className="flex items-center gap-2 font-medium text-left hover:text-gold"
                onClick={() => setSelectedUserId(u.user_id)}
              >
                <span>@{u.username}</span>
                {u.is_banned && (
                  <span className="rounded-full border border-red-400/30 bg-red-400/10 px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider text-red-300">
                    Banni
                  </span>
                )}
                {u.user_id === user?.id && (
                  <span className="rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider text-gold">
                    Vous
                  </span>
                )}
              </button>
              <div
                className="text-xs text-muted-foreground truncate max-w-md"
                title={u.addresses.join(", ")}
              >
                {u.addresses.length ? u.addresses.join(", ") : "aucune adresse"}
              </div>
            </div>
            <div className="text-sm text-muted-foreground tabular-nums">
              {u.mailbox_count} / {u.mailbox_limit} adr.
            </div>
            <div className="text-sm text-gold tabular-nums w-24 text-right">
              {fmtBytes(u.storage_bytes)}
            </div>
            <Input
              type="number"
              min={0}
              max={1000}
              defaultValue={u.mailbox_limit}
              className="w-24"
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (Number.isInteger(v) && v >= 0 && v <= 1000 && v !== u.mailbox_limit) {
                  setLimit.mutate({ user_id: u.user_id, limit: v });
                }
              }}
            />
            <ResetUserPassword userId={u.user_id} username={u.username} />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setSelectedUserId(u.user_id)}
            >
              <SlidersHorizontal className="size-4" /> Gérer
            </Button>
          </div>
        ))}
        {users.length === 0 && (
          <div className="p-12 text-center text-muted-foreground">Aucun utilisateur.</div>
        )}
      </div>
      <UserControlDialog
        user={users.find((entry) => entry.user_id === selectedUserId) ?? null}
        currentUserId={user?.id}
        open={!!selectedUserId}
        onOpenChange={(open) => !open && setSelectedUserId(null)}
        onBan={(userId, duration) => setBan.mutate({ userId, duration })}
        onApiAccess={(userId, enabled) => setApiAccess.mutate({ userId, enabled })}
        onDeleteMailbox={(mailboxId) => deleteMailbox.mutate(mailboxId)}
        pending={setBan.isPending || setApiAccess.isPending || deleteMailbox.isPending}
      />
    </div>
  );
}

type UserControlEntry = {
  user_id: string;
  username: string;
  display_name: string | null;
  is_banned: boolean;
  banned_until: string | null;
  api_access: boolean;
  account_kind: string;
  mailboxes: Array<{
    id: string;
    local_part: string;
    is_temp: boolean;
    expires_at: string | null;
    domain: { name: string } | null;
  }>;
};

function UserControlDialog({
  user,
  currentUserId,
  open,
  onOpenChange,
  onBan,
  onApiAccess,
  onDeleteMailbox,
  pending,
}: {
  user: UserControlEntry | null;
  currentUserId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBan: (userId: string, duration: "1h" | "24h" | "7d" | "permanent" | "none") => void;
  onApiAccess: (userId: string, enabled: boolean) => void;
  onDeleteMailbox: (mailboxId: string) => void;
  pending: boolean;
}) {
  if (!user) return null;
  const self = user.user_id === currentUserId;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl">Gérer @{user.username}</DialogTitle>
          <DialogDescription>
            {user.display_name || "Utilisateur JorgardeMail"} ·{" "}
            {user.account_kind === "guest" ? "compte invité" : "compte membre"}
          </DialogDescription>
        </DialogHeader>

        <section className="rounded-2xl border border-border bg-black/15 p-4">
          <div className="mb-3 flex items-center gap-2 font-semibold">
            <Clock3 className="size-4 text-brand-secondary" /> Accès au compte
          </div>
          {self ? (
            <p className="text-sm text-muted-foreground">
              Votre propre compte ne peut pas être banni.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {user.is_banned && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => onBan(user.user_id, "none")}
                >
                  <UserCheck className="size-4" /> Débannir
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => onBan(user.user_id, "1h")}
              >
                Bannir 1 h
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => onBan(user.user_id, "24h")}
              >
                Bannir 24 h
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => onBan(user.user_id, "7d")}
              >
                Bannir 7 jours
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="border-red-400/30 text-red-300"
                disabled={pending}
                onClick={() =>
                  window.confirm(`Bannir définitivement @${user.username} ?`) &&
                  onBan(user.user_id, "permanent")
                }
              >
                <Ban className="size-4" /> Permanent
              </Button>
            </div>
          )}
          {user.is_banned && user.banned_until && (
            <p className="mt-3 text-xs text-red-300">
              Banni jusqu’au {new Date(user.banned_until).toLocaleString("fr-FR")}
            </p>
          )}
        </section>

        <section className="rounded-2xl border border-border bg-black/15 p-4">
          <div className="flex items-center gap-3">
            <KeyRound className="size-4 text-brand-secondary" />
            <div className="flex-1">
              <div className="font-semibold">API développeur</div>
              <div className="text-xs text-muted-foreground">
                Autorise uniquement création temporaire et lecture.
              </div>
            </div>
            <Switch
              checked={user.api_access}
              disabled={pending || user.account_kind === "guest"}
              onCheckedChange={(enabled) => onApiAccess(user.user_id, enabled)}
            />
          </div>
        </section>

        <section className="rounded-2xl border border-border bg-black/15 p-4">
          <div className="mb-3 font-semibold">Adresses ({user.mailboxes.length})</div>
          <div className="space-y-2">
            {user.mailboxes.map((mailbox) => {
              const protectedAlias = ["postmaster", "abuse"].includes(mailbox.local_part);
              const address = `${mailbox.local_part}@${mailbox.domain?.name ?? ""}`;
              return (
                <div
                  key={mailbox.id}
                  className="flex items-center gap-3 rounded-xl border border-border bg-black/10 p-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-sm">{address}</div>
                    <div className="text-xs text-muted-foreground">
                      {mailbox.is_temp
                        ? `Temporaire · ${mailbox.expires_at ? new Date(mailbox.expires_at).toLocaleString("fr-FR") : "expiration inconnue"}`
                        : "Permanente"}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={pending || protectedAlias}
                    title={protectedAlias ? "Adresse obligatoire" : `Supprimer ${address}`}
                    onClick={() =>
                      window.confirm(`Supprimer ${address} et tous ses messages ?`) &&
                      onDeleteMailbox(mailbox.id)
                    }
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              );
            })}
            {user.mailboxes.length === 0 && (
              <p className="text-sm text-muted-foreground">Aucune adresse.</p>
            )}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`noir-panel rounded-2xl p-4 ${accent ? "glow-gold" : ""}`}>
      <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </div>
      <div className={`mt-1 font-display text-3xl ${accent ? "text-gold" : ""}`}>{value}</div>
    </div>
  );
}

function domainStatus(expires_at: string | null) {
  if (!expires_at)
    return {
      label: "Aucune expiration",
      tone: "text-muted-foreground",
      days: null as number | null,
    };
  const days = Math.ceil((new Date(expires_at).getTime() - Date.now()) / 86400000);
  if (days < 0) return { label: `Expiré depuis ${-days} j`, tone: "text-red-400", days };
  if (days <= 30) return { label: `Expire dans ${days} j`, tone: "text-amber-400", days };
  return { label: `Expire dans ${days} j`, tone: "text-emerald-400", days };
}

function Domains() {
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState("");
  const { data: domains, refetch } = useQuery({
    queryKey: ["admin-domains"],
    queryFn: async () => (await supabase.from("domains").select("*").order("name")).data ?? [],
  });

  const add = useMutation({
    mutationFn: async () => {
      const n = name.trim().toLowerCase();
      if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(n))
        throw new Error("Saisissez un domaine valide, par exemple exemple.fr");
      const { error } = await supabase
        .from("domains")
        .insert({ name: n, expires_at: expiry ? new Date(expiry).toISOString() : null });
      if (error) throw new Error("Ce domaine existe déjà ou ne peut pas être ajouté");
    },
    onSuccess: () => {
      setName("");
      setExpiry("");
      refetch();
      toast.success("Domaine ajouté");
    },
    onError: (error) => toast.error(errorMessage(error, "Impossible d’ajouter le domaine")),
  });

  const updateExpiry = useMutation({
    mutationFn: async ({ id, value }: { id: string; value: string }) => {
      const { error } = await supabase
        .from("domains")
        .update({ expires_at: value ? new Date(value).toISOString() : null })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      refetch();
      toast.success("Expiration mise à jour");
    },
    onError: (error) => toast.error(errorMessage(error, "Impossible de modifier l’expiration")),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase.rpc("delete_domain", { p_domain_id: id });
      if (error) throw error;
      return data;
    },
    onSuccess: (deletedName) => {
      refetch();
      toast.success(`${deletedName} et ses messages ont été supprimés`);
    },
    onError: (error) => toast.error(errorMessage(error, "Impossible de supprimer le domaine")),
  });

  return (
    <div>
      <div className="noir-panel mb-4 grid gap-2 rounded-3xl p-4 md:grid-cols-[1fr_auto_auto]">
        <Input placeholder="exemple.fr" value={name} onChange={(e) => setName(e.target.value)} />
        <Input
          type="date"
          value={expiry}
          onChange={(e) => setExpiry(e.target.value)}
          className="md:w-48"
          title="Expiration chez le registrar (facultatif)"
        />
        <Button onClick={() => add.mutate()} className="bg-gold text-white">
          Ajouter
        </Button>
      </div>
      <div className="noir-panel mail-list divide-y divide-border">
        {(domains ?? []).map((d) => {
          const s = domainStatus(d.expires_at);
          return (
            <div key={d.id} className="mail-row flex flex-wrap items-center gap-4 p-4">
              <div className="font-mono flex-1 min-w-[160px]">{d.name}</div>
              <span className={`text-xs ${s.tone}`}>{s.label}</span>
              <Input
                type="date"
                defaultValue={d.expires_at ? new Date(d.expires_at).toISOString().slice(0, 10) : ""}
                className="w-44"
                onBlur={(e) => {
                  if (
                    e.target.value !==
                    (d.expires_at ? new Date(d.expires_at).toISOString().slice(0, 10) : "")
                  )
                    updateExpiry.mutate({ id: d.id, value: e.target.value });
                }}
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Supprimer ${d.name}`}
                disabled={del.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      `Supprimer définitivement ${d.name}, toutes ses adresses et tous leurs messages ? Cette action est irréversible.`,
                    )
                  ) {
                    del.mutate(d.id);
                  }
                }}
              >
                <Trash2 size={16} />
              </Button>
            </div>
          );
        })}
        {(!domains || domains.length === 0) && (
          <div className="p-12 text-center text-muted-foreground">Aucun domaine.</div>
        )}
      </div>
    </div>
  );
}
