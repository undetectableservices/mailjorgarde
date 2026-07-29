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
import { Trash2, Megaphone, ShieldCheck } from "lucide-react";
import {
  broadcastToAllUsers,
  getAdminUserStats,
  setAdminMailboxLimit,
} from "@/lib/admin-broadcast.functions";
import { SetupWizard } from "@/components/setup-wizard";
import { AdminUserProvisioning, ResetUserPassword } from "@/components/admin-user-provisioning";

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
  const loadStats = useServerFn(getAdminUserStats);
  const updateLimit = useServerFn(setAdminMailboxLimit);
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
              <div className="font-medium">@{u.username}</div>
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
          </div>
        ))}
        {users.length === 0 && (
          <div className="p-12 text-center text-muted-foreground">Aucun utilisateur.</div>
        )}
      </div>
    </div>
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
