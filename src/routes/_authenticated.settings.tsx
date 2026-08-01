import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { PageHeader } from "@/components/page-header";
import { ConfirmAction } from "@/components/confirm-action";
import { Ban, KeyRound, Plus, ShieldBan, Trash2, UserRound } from "lucide-react";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({
    meta: [
      { title: "Préférences — JorgardeMail" },
      { name: "description", content: "Gérez votre compte JorgardeMail." },
    ],
  }),
  component: AccountSettings,
});

function AccountSettings() {
  const { user } = useAuth();
  const [displayName, setDisplayName] = useState("");
  const [density, setDensity] = useState<"cozy" | "compact">("cozy");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [blockType, setBlockType] = useState<"email" | "domain">("email");
  const [blockValue, setBlockValue] = useState("");
  const [blockScope, setBlockScope] = useState("all");

  const { data: profile, refetch } = useQuery({
    queryKey: ["my-profile-settings", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_my_profile", {});
      if (error) throw error;
      return data;
    },
  });

  useEffect(() => {
    if (!profile) return;
    setDisplayName(profile.display_name ?? "");
    setDensity(profile.density as typeof density);
  }, [profile]);

  const saveProfile = useMutation({
    mutationFn: async () => {
      if (!user) throw new Error("Votre session a expiré");
      const cleanName = displayName.trim();
      if (cleanName.length > 100)
        throw new Error("Le nom affiché ne peut pas dépasser 100 caractères");
      const { error } = await supabase
        .from("profiles")
        .update({ display_name: cleanName || null, density })
        .eq("user_id", user.id);
      if (error) throw error;
    },
    onSuccess: async () => {
      await refetch();
      toast.success("Préférences enregistrées");
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Impossible d’enregistrer les préférences",
      ),
  });

  const changePassword = useMutation({
    mutationFn: async () => {
      if (password.length < 12 || password.length > 128) {
        throw new Error("Le mot de passe doit contenir 12 à 128 caractères");
      }
      if (password !== confirmPassword) throw new Error("Les mots de passe ne correspondent pas");
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
    },
    onSuccess: () => {
      setPassword("");
      setConfirmPassword("");
      toast.success("Mot de passe modifié");
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Impossible de modifier le mot de passe",
      ),
  });

  const { data: mailboxes = [] } = useQuery({
    queryKey: ["settings-mailboxes", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("mailboxes")
        .select("id, local_part, domain:domains(name)")
        .eq("user_id", user!.id)
        .order("created_at");
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: blockedSenders = [], refetch: refetchBlocked } = useQuery({
    queryKey: ["blocked-senders", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("blocked_senders")
        .select(
          "id, match_type, match_value, mailbox_id, created_at, mailbox:mailboxes(local_part, domain:domains(name))",
        )
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const addBlock = useMutation({
    mutationFn: async () => {
      const value = blockValue.trim().toLowerCase();
      if (!value) throw new Error("Saisissez une adresse ou un domaine");
      const { error } = await supabase.rpc("create_block_rule", {
        p_match_type: blockType,
        p_match_value: value,
        p_mailbox_id: blockScope === "all" ? null : blockScope,
      });
      if (error) throw error;
    },
    onSuccess: async () => {
      setBlockValue("");
      await refetchBlocked();
      toast.success("Règle de blocage ajoutée");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Impossible d’ajouter cette règle"),
  });

  const deleteBlock = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("blocked_senders").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: async () => {
      await refetchBlocked();
      toast.success("Règle de blocage supprimée");
    },
    onError: () => toast.error("Impossible de supprimer cette règle"),
  });

  return (
    <div className="app-page app-page-narrow">
      <PageHeader
        eyebrow="Votre espace"
        title="Préférences"
        description="Personnalisez votre identité, l’affichage de vos messages et vos accès."
      />

      <section className="noir-panel space-y-5 rounded-3xl p-5 sm:p-7">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-primary/10 text-brand-secondary ring-1 ring-primary/15">
            <UserRound className="size-5" />
          </div>
          <div>
            <h2 className="font-display text-2xl">Profil</h2>
            <p className="text-xs text-muted-foreground">
              Identifiant :{" "}
              <span className="font-mono text-foreground">@{profile?.username ?? "…"}</span>
            </p>
          </div>
        </div>
        <div>
          <Label htmlFor="account-display-name">Nom affiché</Label>
          <Input
            id="account-display-name"
            maxLength={100}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </div>
        <div className="max-w-sm">
          <Label>Densité des messages</Label>
          <Select value={density} onValueChange={(value) => setDensity(value as typeof density)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="cozy">Confortable</SelectItem>
              <SelectItem value="compact">Compacte</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button
          type="button"
          className="bg-gold text-white"
          disabled={!profile || saveProfile.isPending}
          onClick={() => saveProfile.mutate()}
        >
          {saveProfile.isPending ? "Enregistrement…" : "Enregistrer les préférences"}
        </Button>
      </section>

      <section className="noir-panel mt-4 space-y-5 rounded-3xl p-5 sm:p-7">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-red-400/10 text-red-300 ring-1 ring-red-400/15">
            <ShieldBan className="size-5" />
          </div>
          <div>
            <h2 className="font-display text-2xl">Expéditeurs bloqués</h2>
            <p className="text-xs text-muted-foreground">
              Les messages correspondants vont directement dans les indésirables, sans notification.
            </p>
          </div>
        </div>

        <div className="grid gap-2 lg:grid-cols-[9rem_minmax(12rem,1fr)_minmax(12rem,1fr)_auto]">
          <Select
            value={blockType}
            onValueChange={(value) => setBlockType(value as typeof blockType)}
          >
            <SelectTrigger aria-label="Type de blocage">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="email">Adresse</SelectItem>
              <SelectItem value="domain">Domaine</SelectItem>
            </SelectContent>
          </Select>
          <Input
            value={blockValue}
            onChange={(event) => setBlockValue(event.target.value)}
            placeholder={blockType === "email" ? "expediteur@exemple.com" : "exemple.com"}
            maxLength={320}
          />
          <Select value={blockScope} onValueChange={setBlockScope}>
            <SelectTrigger aria-label="Portée du blocage">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Toutes mes adresses</SelectItem>
              {mailboxes.map((mailbox) => (
                <SelectItem key={mailbox.id} value={mailbox.id}>
                  {mailbox.local_part}@{mailbox.domain?.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            className="bg-gold text-white"
            disabled={!blockValue.trim() || addBlock.isPending}
            onClick={() => addBlock.mutate()}
          >
            <Plus className="size-4" /> Ajouter
          </Button>
        </div>

        <div className="space-y-2">
          {blockedSenders.map((rule) => {
            const scopedAddress = rule.mailbox
              ? `${rule.mailbox.local_part}@${rule.mailbox.domain?.name}`
              : "Toutes mes adresses";
            return (
              <div
                key={rule.id}
                className="flex items-center gap-3 rounded-2xl border border-border bg-black/10 p-3"
              >
                <Ban className="size-4 shrink-0 text-red-300" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-sm">
                    {rule.match_type === "domain" ? "@" : ""}
                    {rule.match_value}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {scopedAddress}
                  </div>
                </div>
                <ConfirmAction
                  title="Supprimer cette règle de blocage ?"
                  description="Les prochains messages de cet expéditeur pourront à nouveau arriver dans votre boîte de réception."
                  confirmLabel="Supprimer la règle"
                  onConfirm={() => deleteBlock.mutate(rule.id)}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={deleteBlock.isPending}
                    aria-label={`Supprimer le blocage de ${rule.match_value}`}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </ConfirmAction>
              </div>
            );
          })}
          {blockedSenders.length === 0 && (
            <div className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              Aucun expéditeur bloqué.
            </div>
          )}
        </div>
      </section>

      <section className="noir-panel mt-4 space-y-5 rounded-3xl p-5 sm:p-7">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-primary/10 text-brand-secondary ring-1 ring-primary/15">
            <KeyRound className="size-5" />
          </div>
          <div>
            <h2 className="font-display text-2xl">Modifier le mot de passe</h2>
            <p className="text-xs text-muted-foreground">
              Utilisez au moins 12 caractères. Votre administrateur ne peut pas consulter ce mot de
              passe.
            </p>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="account-new-password">Nouveau mot de passe</Label>
            <Input
              id="account-new-password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="account-confirm-password">Confirmer le mot de passe</Label>
            <Input
              id="account-confirm-password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={!password || changePassword.isPending}
          onClick={() => changePassword.mutate()}
        >
          {changePassword.isPending ? "Modification…" : "Modifier le mot de passe"}
        </Button>
      </section>
    </div>
  );
}
