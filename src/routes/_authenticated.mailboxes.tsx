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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PageHeader } from "@/components/page-header";
import { ConfirmAction } from "@/components/confirm-action";
import { toast } from "sonner";
import {
  AtSign,
  CalendarClock,
  Clock3,
  Infinity as InfinityIcon,
  Plus,
  Trash2,
} from "lucide-react";

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
const EXTENSION_PRESETS = [
  { label: "1 heure", shortLabel: "+ 1 h", minutes: 60 },
  { label: "1 jour", shortLabel: "+ 1 jour", minutes: 60 * 24 },
  { label: "7 jours", shortLabel: "+ 7 jours", minutes: 60 * 24 * 7 },
  { label: "30 jours", shortLabel: "+ 30 jours", minutes: 60 * 24 * 30 },
] as const;

function remainingLifetime(expiresAt: string | null): string {
  if (!expiresAt) return "Expiration inconnue";
  const minutes = Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 60_000));
  if (minutes < 60) return `${minutes} min restantes`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${hours} h restantes`;
  return `${Math.ceil(hours / 24)} jours restants`;
}

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
  const { data: isAdmin } = useQuery({
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
          .eq("user_id", user!.id)
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
      if (!isAdmin && (RESERVED.has(lp) || RESERVED.has(head))) {
        throw new Error("Ce nom est réservé aux administrateurs");
      }
      if (profile?.account_kind === "guest")
        throw new Error("Les adresses invitées sont gérées automatiquement");
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
    onSuccess: async (_result, deletedId) => {
      qc.setQueryData(["mailboxes-full", user?.id], (current: typeof mailboxes) =>
        current?.filter((mailbox) => mailbox.id !== deletedId),
      );
      toast.success("Adresse supprimée");
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["mailboxes"] }),
        qc.invalidateQueries({ queryKey: ["mail-unread-by-mailbox"] }),
        refetch(),
      ]);
    },
    onError: (error) => toast.error(errorMessage(error, "Impossible de supprimer l’adresse")),
  });

  const extend = useMutation({
    mutationFn: async ({ id, minutes }: { id: string; minutes: number | null }) => {
      const { data, error } = await supabase.rpc("set_mailbox_lifetime", {
        p_mailbox_id: id,
        p_ttl_minutes: minutes,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (updated, variables) => {
      // Apply the authoritative row immediately. This also removes the
      // ephemeral badge the instant the address becomes permanent.
      if (updated) {
        qc.setQueryData(["mailboxes-full", user?.id], (current: typeof mailboxes) =>
          current?.map((mailbox) =>
            mailbox.id === updated.id
              ? {
                  ...mailbox,
                  is_temp: updated.is_temp,
                  expires_at: updated.expires_at,
                }
              : mailbox,
          ),
        );
      }
      toast.success(variables.minutes === null ? "Adresse rendue permanente" : "Durée prolongée");
      void qc.invalidateQueries({ queryKey: ["mailboxes"] });
      void refetch();
    },
    onError: (error) => toast.error(errorMessage(error, "Impossible de modifier l’adresse")),
  });

  const setRemaining = useMutation({
    mutationFn: async ({ id, minutes }: { id: string; minutes: number }) => {
      const { data, error } = await supabase.rpc("set_mailbox_remaining", {
        p_mailbox_id: id,
        p_ttl_minutes: minutes,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (updated) => {
      if (updated) {
        qc.setQueryData(["mailboxes-full", user?.id], (current: typeof mailboxes) =>
          current?.map((mailbox) =>
            mailbox.id === updated.id
              ? { ...mailbox, is_temp: updated.is_temp, expires_at: updated.expires_at }
              : mailbox,
          ),
        );
      }
      toast.success("Temps restant personnalisé appliqué");
      void qc.invalidateQueries({ queryKey: ["mailboxes"] });
      void refetch();
    },
    onError: (error) => toast.error(errorMessage(error, "Impossible de définir cette durée")),
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

      {profile?.account_kind !== "guest" && (
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
      )}

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
              {mb.is_temp ? (
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full border border-amber-300/20 bg-amber-300/10 px-2 py-0.5 font-semibold text-amber-200">
                    Éphémère
                  </span>
                  <span className="text-muted-foreground">{remainingLifetime(mb.expires_at)}</span>
                </div>
              ) : (
                <div className="mt-1 text-xs text-muted-foreground">Adresse permanente</div>
              )}
            </div>
            {mb.is_temp && profile?.account_kind !== "guest" && (
              <MailboxLifetimeControl
                address={`${mb.local_part}@${mb.domain?.name}`}
                expiresAt={mb.expires_at}
                pending={extend.isPending || setRemaining.isPending}
                onChange={(minutes) => extend.mutate({ id: mb.id, minutes })}
                onSetRemaining={(minutes) => setRemaining.mutate({ id: mb.id, minutes })}
              />
            )}
            {profile?.account_kind !== "guest" && !REQUIRED_DOMAIN_ALIASES.has(mb.local_part) && (
              <ConfirmAction
                title={`Supprimer ${mb.local_part}@${mb.domain?.name} ?`}
                description="L’adresse, ses e-mails et ses pièces jointes seront supprimés définitivement."
                confirmLabel="Supprimer l’adresse"
                onConfirm={() => del.mutate(mb.id)}
              >
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Supprimer ${mb.local_part}@${mb.domain?.name}`}
                  disabled={del.isPending}
                >
                  <Trash2 size={16} />
                </Button>
              </ConfirmAction>
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

function MailboxLifetimeControl({
  address,
  expiresAt,
  pending,
  onChange,
  onSetRemaining,
}: {
  address: string;
  expiresAt: string | null;
  pending: boolean;
  onChange: (minutes: number | null) => void;
  onSetRemaining: (minutes: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [customValue, setCustomValue] = useState("60");
  const [customUnit, setCustomUnit] = useState<"minutes" | "hours" | "days">("minutes");

  const choose = (minutes: number | null) => {
    setOpen(false);
    onChange(minutes);
  };
  const customMinutes = Math.round(
    Number(customValue) * (customUnit === "days" ? 1440 : customUnit === "hours" ? 60 : 1),
  );
  const validCustom =
    Number.isFinite(customMinutes) && customMinutes >= 1 && customMinutes <= 43200;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          className="rounded-xl border-amber-300/20 bg-amber-300/[0.06] text-amber-100 hover:bg-amber-300/10 hover:text-amber-50"
        >
          <Clock3 className="size-4" />
          {pending ? "Mise à jour…" : "Gérer la durée"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))] rounded-2xl p-0">
        <div className="border-b border-border p-4">
          <div className="flex items-start gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-amber-300/10 text-amber-200 ring-1 ring-amber-300/15">
              <CalendarClock className="size-5" />
            </div>
            <div className="min-w-0">
              <div className="font-semibold">Durée de l’adresse</div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground" title={address}>
                {address}
              </div>
            </div>
          </div>
          <div className="mt-4 rounded-xl border border-amber-300/15 bg-amber-300/[0.05] p-3">
            <div className="text-sm font-semibold text-amber-100">
              {remainingLifetime(expiresAt)}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              Expiration le {expiresAt ? new Date(expiresAt).toLocaleString("fr-FR") : "—"}
            </div>
          </div>
        </div>
        <div className="p-4">
          <div className="mb-2 text-[0.68rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">
            Ajouter du temps
          </div>
          <div className="grid grid-cols-2 gap-2">
            {EXTENSION_PRESETS.map((preset) => (
              <Button
                key={preset.minutes}
                type="button"
                variant="outline"
                className="justify-start rounded-xl"
                title={`Prolonger de ${preset.label}`}
                onClick={() => choose(preset.minutes)}
              >
                {preset.shortLabel}
              </Button>
            ))}
          </div>
          <div className="mt-4 border-t border-border pt-4">
            <div className="mb-2 text-[0.68rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Temps restant personnalisé
            </div>
            <div className="grid grid-cols-[1fr_9rem] gap-2">
              <Input
                type="number"
                min={1}
                max={customUnit === "days" ? 30 : customUnit === "hours" ? 720 : 43200}
                step="1"
                value={customValue}
                onChange={(event) => setCustomValue(event.target.value)}
                aria-label="Durée personnalisée"
              />
              <Select
                value={customUnit}
                onValueChange={(value) => setCustomUnit(value as typeof customUnit)}
              >
                <SelectTrigger aria-label="Unité de durée">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="minutes">Minutes</SelectItem>
                  <SelectItem value="hours">Heures</SelectItem>
                  <SelectItem value="days">Jours</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              type="button"
              variant="outline"
              className="mt-2 w-full rounded-xl"
              disabled={!validCustom || pending}
              onClick={() => {
                setOpen(false);
                onSetRemaining(customMinutes);
              }}
            >
              Définir exactement ce temps restant
            </Button>
            <p className="mt-2 text-[0.68rem] text-muted-foreground">
              Minimum 1 minute, maximum 30 jours.
            </p>
          </div>
          <Button
            type="button"
            className="mt-3 w-full rounded-xl bg-gold text-white"
            onClick={() => choose(null)}
          >
            <InfinityIcon className="size-4" /> Rendre permanente
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
