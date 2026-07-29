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
import { KeyRound, UserRound } from "lucide-react";

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
