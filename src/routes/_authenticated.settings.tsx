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
      { title: "Account settings — JorgardeMail" },
      { name: "description", content: "Manage your local JorgardeMail account." },
    ],
  }),
  component: AccountSettings,
});

function AccountSettings() {
  const { user } = useAuth();
  const [displayName, setDisplayName] = useState("");
  const [dmPrivacy, setDmPrivacy] = useState<"anyone" | "contacts" | "nobody">("anyone");
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
    setDmPrivacy(profile.dm_privacy as typeof dmPrivacy);
    setDensity(profile.density as typeof density);
  }, [profile]);

  const saveProfile = useMutation({
    mutationFn: async () => {
      if (!user) throw new Error("You are not signed in");
      const cleanName = displayName.trim();
      if (cleanName.length > 100) throw new Error("Display name must be 100 characters or fewer");
      const { error } = await supabase
        .from("profiles")
        .update({ display_name: cleanName || null, dm_privacy: dmPrivacy, density })
        .eq("user_id", user.id);
      if (error) throw error;
    },
    onSuccess: async () => {
      await refetch();
      toast.success("Account preferences saved");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not save account preferences"),
  });

  const changePassword = useMutation({
    mutationFn: async () => {
      if (password.length < 12 || password.length > 128) {
        throw new Error("Password must be 12–128 characters");
      }
      if (password !== confirmPassword) throw new Error("Passwords do not match");
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
    },
    onSuccess: () => {
      setPassword("");
      setConfirmPassword("");
      toast.success("Password changed");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not change password"),
  });

  return (
    <div className="app-page app-page-narrow">
      <PageHeader
        eyebrow="Personal controls"
        title="Account settings"
        description="Tune your identity, privacy, and local credentials. Your account and direct messages stay on this server."
      />

      <section className="noir-panel space-y-4 rounded-2xl p-5 sm:p-6">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-primary/10 text-brand-secondary ring-1 ring-primary/15">
            <UserRound className="size-5" />
          </div>
          <div>
            <h2 className="font-display text-2xl">Profile</h2>
            <p className="text-xs text-muted-foreground">
              Username:{" "}
              <span className="font-mono text-foreground">@{profile?.username ?? "…"}</span>
            </p>
          </div>
        </div>
        <div>
          <Label htmlFor="account-display-name">Display name</Label>
          <Input
            id="account-display-name"
            maxLength={100}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label>Who may start a DM</Label>
            <Select
              value={dmPrivacy}
              onValueChange={(value) => setDmPrivacy(value as typeof dmPrivacy)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="anyone">Any local user</SelectItem>
                <SelectItem value="nobody">Nobody new</SelectItem>
                <SelectItem value="contacts" disabled>
                  Contacts (not available yet)
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Message density</Label>
            <Select value={density} onValueChange={(value) => setDensity(value as typeof density)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cozy">Cozy</SelectItem>
                <SelectItem value="compact">Compact</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <Button
          type="button"
          className="bg-gold text-white"
          disabled={!profile || saveProfile.isPending}
          onClick={() => saveProfile.mutate()}
        >
          {saveProfile.isPending ? "Saving…" : "Save preferences"}
        </Button>
      </section>

      <section className="noir-panel mt-4 space-y-4 rounded-2xl p-5 sm:p-6">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-primary/10 text-brand-secondary ring-1 ring-primary/15">
            <KeyRound className="size-5" />
          </div>
          <div>
            <h2 className="font-display text-2xl">Change password</h2>
            <p className="text-xs text-muted-foreground">
              Use at least 12 characters. Your administrator cannot see this password.
            </p>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="account-new-password">New password</Label>
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
            <Label htmlFor="account-confirm-password">Confirm password</Label>
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
          {changePassword.isPending ? "Changing…" : "Change password"}
        </Button>
      </section>
    </div>
  );
}
