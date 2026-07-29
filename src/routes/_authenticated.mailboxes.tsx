import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { PageHeader } from "@/components/page-header";
import { toast } from "sonner";
import { AtSign, Plus, Trash2 } from "lucide-react";

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

const RESERVED = new Set([
  "admin",
  "administrator",
  "server",
  "owner",
  "root",
  "postmaster",
  "support",
  "no-reply",
  "noreply",
  "abuse",
  "webmaster",
  "hostmaster",
  "security",
  "info",
]);
const REQUIRED_DOMAIN_ALIASES = new Set(["postmaster", "abuse"]);
const TTL_PRESETS: Array<{ label: string; minutes: number | null }> = [
  { label: "10 minutes", minutes: 10 },
  { label: "1 heure", minutes: 60 },
  { label: "1 jour", minutes: 60 * 24 },
  { label: "7 jours", minutes: 60 * 24 * 7 },
  { label: "30 jours", minutes: 60 * 24 * 30 },
];

export const Route = createFileRoute("/_authenticated/mailboxes")({
  head: () => ({
    meta: [
      { title: "Mes adresses — JorgardeMail" },
      {
        name: "description",
        content: "Créez et gérez vos adresses e-mail.",
      },
    ],
  }),
  component: Mailboxes,
});

function Mailboxes() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [local, setLocal] = useState("");
  const [domainId, setDomainId] = useState<string>("");
  const [isTemp, setIsTemp] = useState(false);
  const [ttl, setTtl] = useState(60);

  const { data: profile } = useQuery({
    queryKey: ["profile", user?.id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_my_profile");
      if (error) throw error;
      return data;
    },
    enabled: !!user,
  });
  const { data: domains } = useQuery({
    queryKey: ["domains"],
    queryFn: async () => (await supabase.from("domains").select("*").order("name")).data ?? [],
  });
  const { data: mailboxes, refetch } = useQuery({
    queryKey: ["mailboxes-full", user?.id],
    enabled: !!user,
    queryFn: async () =>
      (
        await supabase
          .from("mailboxes")
          .select("*, domain:domains(name, expires_at)")
          .order("created_at", { ascending: false })
      ).data ?? [],
  });

  const domainExpiry = (expires_at: string | null | undefined) => {
    if (!expires_at) return null;
    const days = Math.ceil((new Date(expires_at).getTime() - Date.now()) / 86400000);
    if (days < 0) return { text: `Domaine expiré depuis ${-days} j`, tone: "text-red-400" };
    if (days <= 30) return { text: `Domaine expirant dans ${days} j`, tone: "text-amber-400" };
    return null;
  };

  const limit = profile?.mailbox_limit ?? 30;
  // RFC-required role aliases are installed for every domain and intentionally
  // do not consume the account's personal mailbox allowance.
  const used = (mailboxes ?? []).filter(
    (mailbox) => !REQUIRED_DOMAIN_ALIASES.has(mailbox.local_part),
  ).length;

  const create = useMutation({
    mutationFn: async () => {
      const lp = local.trim().toLowerCase();
      if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(lp) || lp.includes("..")) {
        throw new Error("Adresse invalide (1 à 64 caractères : a-z, 0-9, . _ -)");
      }
      const head = lp.split(/[._-]/)[0];
      if (RESERVED.has(lp) || RESERVED.has(head)) throw new Error("Ce nom est réservé");
      if (!domainId) throw new Error("Choisissez un domaine");
      if (used >= limit) throw new Error(`Quota atteint (${limit} adresses)`);
      const { error } = await supabase.rpc("create_mailbox", {
        p_local_part: lp,
        p_domain_id: domainId,
        p_is_temp: isTemp,
        p_ttl_minutes: isTemp ? ttl : null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Adresse créée");
      setLocal("");
      qc.invalidateQueries({ queryKey: ["mailboxes"] });
      refetch();
    },
    onError: (error) => toast.error(errorMessage(error, "Impossible de créer l’adresse")),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("delete_mailbox", { p_mailbox_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Adresse supprimée");
      qc.invalidateQueries({ queryKey: ["mailboxes"] });
      refetch();
    },
    onError: (error) => toast.error(errorMessage(error, "Impossible de supprimer l’adresse")),
  });

  const extend = useMutation({
    mutationFn: async ({ id, minutes }: { id: string; minutes: number | null }) => {
      const { error } = await supabase.rpc("set_mailbox_lifetime", {
        p_mailbox_id: id,
        p_ttl_minutes: minutes,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Durée mise à jour");
      refetch();
    },
    onError: (error) => toast.error(errorMessage(error, "Impossible de modifier l’adresse")),
  });

  return (
    <div className="app-page">
      <PageHeader
        eyebrow="Gestion des adresses"
        title="Mes adresses"
        description={`Créez des adresses permanentes ou éphémères. Votre compte peut en posséder jusqu’à ${limit}.`}
        actions={
          <div className="premium-badge normal-case tracking-normal">
            <AtSign className="size-3.5" /> {Math.max(0, limit - used)} disponible
            {Math.max(0, limit - used) > 1 ? "s" : ""}
          </div>
        }
      />

      <div className="noir-panel mb-6 rounded-3xl p-5">
        <div className="flex items-center justify-between mb-2 text-sm">
          <span>
            {used} / {limit} utilisées
          </span>
          <span className="text-muted-foreground">{Math.max(0, limit - used)} restantes</span>
        </div>
        <Progress
          value={limit > 0 ? Math.min(100, (used / limit) * 100) : used > 0 ? 100 : 0}
          className="h-2"
        />
      </div>

      <div className="noir-panel mb-8 space-y-4 rounded-3xl p-5 sm:p-7">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-primary/10 text-brand-secondary ring-1 ring-primary/15">
            <Plus className="size-5" />
          </div>
          <div>
            <h2 className="font-display text-xl">Créer une adresse</h2>
            <p className="text-xs text-muted-foreground">Choisissez un domaine et une durée.</p>
          </div>
        </div>
        {!domains || domains.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            Aucun domaine n’est encore configuré. Un administrateur doit d’abord en ajouter un.
          </div>
        ) : (
          <>
            <div className="grid md:grid-cols-[1fr_auto_1fr] gap-2 items-center">
              <Input
                placeholder="nom-de-l’adresse"
                value={local}
                onChange={(e) => setLocal(e.target.value)}
              />
              <span className="text-muted-foreground">@</span>
              <Select value={domainId} onValueChange={setDomainId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choisir un domaine" />
                </SelectTrigger>
                <SelectContent>
                  {domains.map((d) => {
                    const e = domainExpiry(d.expires_at);
                    return (
                      <SelectItem key={d.id} value={d.id}>
                        <span className="flex items-center gap-2">
                          {d.name}
                          {e && <span className={`text-[10px] ${e.tone}`}>• {e.text}</span>}
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-wrap gap-4 items-center">
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={isTemp} onCheckedChange={setIsTemp} /> Éphémère
              </label>
              {isTemp && (
                <Select value={String(ttl)} onValueChange={(v) => setTtl(Number(v))}>
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TTL_PRESETS.map((p) => (
                      <SelectItem key={p.label} value={String(p.minutes)}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Button
                onClick={() => create.mutate()}
                disabled={create.isPending}
                className="bg-gold ml-auto text-white"
              >
                Créer
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Certains noms techniques sont réservés et ne peuvent pas être utilisés.
            </p>
          </>
        )}
      </div>

      <div className="noir-panel mail-list divide-y divide-border">
        {(mailboxes ?? []).map((mb) => (
          <div key={mb.id} className="mail-row flex items-center gap-4 p-4">
            <div className="flex-1 min-w-0">
              <div className="font-mono truncate flex items-center gap-2">
                <span>
                  {mb.local_part}@{mb.domain?.name}
                </span>
                {(() => {
                  const e = domainExpiry(mb.domain?.expires_at);
                  return e ? (
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded border border-current ${e.tone}`}
                    >
                      {e.text}
                    </span>
                  ) : null;
                })()}
              </div>
              <div className="text-xs text-muted-foreground">
                {mb.is_temp
                  ? `Éphémère — expire ${mb.expires_at ? new Date(mb.expires_at).toLocaleString("fr-FR") : "?"}`
                  : "Permanente"}
              </div>
            </div>
            {mb.is_temp && (
              <Select
                onValueChange={(v) =>
                  extend.mutate({ id: mb.id, minutes: v === "perm" ? null : Number(v) })
                }
              >
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="Prolonger" />
                </SelectTrigger>
                <SelectContent>
                  {TTL_PRESETS.map((p) => (
                    <SelectItem key={p.label} value={String(p.minutes)}>
                      +{p.label}
                    </SelectItem>
                  ))}
                  <SelectItem value="perm">Rendre permanente</SelectItem>
                </SelectContent>
              </Select>
            )}
            {!REQUIRED_DOMAIN_ALIASES.has(mb.local_part) && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Supprimer ${mb.local_part}@${mb.domain?.name}`}
                disabled={del.isPending}
                onClick={() => {
                  const address = `${mb.local_part}@${mb.domain?.name}`;
                  if (
                    window.confirm(
                      `Supprimer ${address} ainsi que tous ses messages ? Cette action est irréversible.`,
                    )
                  ) {
                    del.mutate(mb.id);
                  }
                }}
              >
                <Trash2 size={16} />
              </Button>
            )}
          </div>
        ))}
        {(!mailboxes || mailboxes.length === 0) && (
          <div className="empty-state">
            <div>
              <AtSign className="mx-auto mb-4 size-8 text-brand-secondary/70" />
              Aucune adresse pour le moment.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
