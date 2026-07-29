import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, KeyRound, RefreshCw, Send, Server, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  getAdminControlState,
  resetJellyfinConfiguration,
  resetSmtpConfiguration,
  saveJellyfinConfiguration,
  saveSmtpConfiguration,
  testJellyfinConfiguration,
  testSmtpConfiguration,
} from "@/lib/admin-control.functions";

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function StatePill({ ok, text }: { ok: boolean; text: string }) {
  return (
    <span
      className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
        ok
          ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
          : "border-amber-400/30 bg-amber-400/10 text-amber-300"
      }`}
    >
      {text}
    </span>
  );
}

export function AdminServicesControl() {
  const load = useServerFn(getAdminControlState);
  const testJellyfin = useServerFn(testJellyfinConfiguration);
  const saveJellyfin = useServerFn(saveJellyfinConfiguration);
  const resetJellyfin = useServerFn(resetJellyfinConfiguration);
  const testSmtp = useServerFn(testSmtpConfiguration);
  const saveSmtp = useServerFn(saveSmtpConfiguration);
  const resetSmtp = useServerFn(resetSmtpConfiguration);

  const { data, refetch, isLoading, isError } = useQuery({
    queryKey: ["admin-control-state"],
    queryFn: () => load(),
  });

  const [jellyfinEnabled, setJellyfinEnabled] = useState(false);
  const [jellyfinUrl, setJellyfinUrl] = useState("");
  const [jellyfinKey, setJellyfinKey] = useState("");
  const [jellyfinResult, setJellyfinResult] = useState<Awaited<
    ReturnType<typeof testJellyfin>
  > | null>(null);
  const [smtpEnabled, setSmtpEnabled] = useState(false);
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState<465 | 587>(587);
  const [smtpSecurity, setSmtpSecurity] = useState<"starttls" | "tls">("starttls");
  const [smtpUsername, setSmtpUsername] = useState("");
  const [smtpPassword, setSmtpPassword] = useState("");
  const [smtpMaxRecipients, setSmtpMaxRecipients] = useState(25);
  const [smtpVerified, setSmtpVerified] = useState(false);

  useEffect(() => {
    if (!data) return;
    setJellyfinEnabled(data.jellyfin.enabled);
    setJellyfinUrl(data.jellyfin.url);
    setSmtpEnabled(data.smtp.enabled);
    setSmtpHost(data.smtp.host);
    setSmtpPort(data.smtp.port === 465 ? 465 : 587);
    setSmtpSecurity(data.smtp.port === 465 ? "tls" : "starttls");
    setSmtpUsername(data.smtp.username);
    setSmtpMaxRecipients(data.smtp.maxRecipients);
  }, [data]);

  const jellyfinPayload = () => ({
    url: jellyfinUrl.trim(),
    apiKey: jellyfinKey || undefined,
  });
  const smtpPayload = () => ({
    host: smtpHost.trim(),
    port: smtpPort,
    security: smtpSecurity,
    username: smtpUsername.trim(),
    password: smtpPassword || undefined,
    maxRecipients: smtpMaxRecipients,
  });

  const jellyfinTest = useMutation({
    mutationFn: () => testJellyfin({ data: jellyfinPayload() }),
    onSuccess: (result) => {
      setJellyfinResult(result);
      toast.success(`${result.serverName} répond — ${result.enabledUserCount} compte(s) actif(s)`);
    },
    onError: (error) => toast.error(message(error, "Le test Jellyfin a échoué")),
  });
  const jellyfinSave = useMutation({
    mutationFn: () =>
      saveJellyfin({
        data: {
          ...jellyfinPayload(),
          expectedRevision: data?.jellyfin.revision ?? 0,
          enabled: jellyfinEnabled,
        },
      }),
    onSuccess: async (result) => {
      setJellyfinResult(result.test);
      setJellyfinKey("");
      await refetch();
      toast.success("Configuration Jellyfin appliquée sans redémarrage");
    },
    onError: (error) => toast.error(message(error, "Enregistrement Jellyfin impossible")),
  });
  const jellyfinReset = useMutation({
    mutationFn: () => resetJellyfin({ data: { expectedRevision: data?.jellyfin.revision ?? 0 } }),
    onSuccess: async () => {
      setJellyfinKey("");
      setJellyfinResult(null);
      await refetch();
      toast.success("Configuration Jellyfin de l’installateur restaurée");
    },
  });

  const smtpTestMutation = useMutation({
    mutationFn: () => testSmtp({ data: smtpPayload() }),
    onSuccess: () => {
      setSmtpVerified(true);
      toast.success("Authentification au relais SMTP réussie");
    },
    onError: (error) => {
      setSmtpVerified(false);
      toast.error(message(error, "Le test SMTP a échoué"));
    },
  });
  const smtpSaveMutation = useMutation({
    mutationFn: () =>
      saveSmtp({
        data: {
          ...smtpPayload(),
          expectedRevision: data?.smtp.revision ?? 0,
          enabled: smtpEnabled,
        },
      }),
    onSuccess: async (result) => {
      setSmtpVerified(Boolean(result.test));
      setSmtpPassword("");
      await refetch();
      toast.success("Relais SMTP appliqué sans redémarrage");
    },
    onError: (error) => toast.error(message(error, "Enregistrement SMTP impossible")),
  });
  const smtpResetMutation = useMutation({
    mutationFn: () => resetSmtp({ data: { expectedRevision: data?.smtp.revision ?? 0 } }),
    onSuccess: async () => {
      setSmtpPassword("");
      setSmtpVerified(false);
      await refetch();
      toast.success("Configuration SMTP de l’installateur restaurée");
    },
  });

  if (isLoading)
    return (
      <div className="noir-panel rounded-3xl p-8 text-muted-foreground">
        Chargement du centre de contrôle…
      </div>
    );
  if (isError || !data) {
    return (
      <div className="noir-panel rounded-3xl border-red-400/20 p-8">
        <p className="text-red-300">Le centre de contrôle est indisponible.</p>
        <Button className="mt-4" variant="outline" onClick={() => refetch()}>
          <RefreshCw size={15} /> Réessayer
        </Button>
      </div>
    );
  }

  const jellyfinReady = Boolean(jellyfinUrl && (jellyfinKey || data.jellyfin.apiKeySet));
  const smtpReady = Boolean(smtpHost && smtpUsername && (smtpPassword || data.smtp.passwordSet));

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          [
            "Jellyfin",
            data.jellyfin.apiKeySet,
            data.jellyfin.apiKeySet ? "Clé protégée" : "À configurer",
          ],
          [
            "Inscriptions",
            data.jellyfin.enabled,
            data.jellyfin.enabled ? "Autorisées" : "Suspendues",
          ],
          [
            "Relais SMTP",
            data.smtp.passwordSet,
            data.smtp.passwordSet ? "Secret protégé" : "À configurer",
          ],
          ["Envoi externe", data.smtp.enabled, data.smtp.enabled ? "Activé" : "Désactivé"],
        ].map(([label, ok, value]) => (
          <div key={String(label)} className="noir-panel rounded-2xl p-4">
            <div className="text-[11px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
              {String(label)}
            </div>
            <div
              className={`mt-2 font-display text-xl ${ok ? "text-emerald-300" : "text-amber-300"}`}
            >
              {String(value)}
            </div>
          </div>
        ))}
      </div>

      <section className="noir-panel rounded-3xl p-5 sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex gap-3">
            <div className="grid size-11 place-items-center rounded-2xl bg-violet-400/10 text-violet-300">
              <Server size={20} />
            </div>
            <div>
              <h2 className="font-display text-2xl">Connexion Jellyfin</h2>
              <p className="text-sm text-muted-foreground">
                Contrôle l’accès aux inscriptions avec les comptes de votre serveur.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <StatePill
              ok={data.jellyfin.source === "panel"}
              text={data.jellyfin.source === "panel" ? "Géré ici" : "Importé de l’installateur"}
            />
            <Switch
              checked={jellyfinEnabled}
              onCheckedChange={setJellyfinEnabled}
              aria-label="Autoriser les inscriptions Jellyfin"
            />
          </div>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-[1fr_1fr_auto]">
          <label className="space-y-2 text-sm">
            <span>Adresse du serveur</span>
            <Input
              value={jellyfinUrl}
              onChange={(e) => setJellyfinUrl(e.target.value)}
              placeholder="http://host.docker.internal:8096"
            />
          </label>
          <label className="space-y-2 text-sm">
            <span>Clé API</span>
            <Input
              type="password"
              value={jellyfinKey}
              onChange={(e) => setJellyfinKey(e.target.value)}
              placeholder={
                data.jellyfin.apiKeySet
                  ? "••••••••  laisser vide pour conserver"
                  : "Coller la clé Jellyfin"
              }
            />
          </label>
          <div className="flex items-end gap-2">
            <Button
              variant="outline"
              disabled={!jellyfinReady || jellyfinTest.isPending}
              onClick={() => jellyfinTest.mutate()}
            >
              {jellyfinTest.isPending ? "Test…" : "Tester"}
            </Button>
            <Button
              className="bg-gold text-background"
              disabled={(jellyfinEnabled && !jellyfinReady) || jellyfinSave.isPending}
              onClick={() => jellyfinSave.mutate()}
            >
              {jellyfinSave.isPending ? "Application…" : "Appliquer"}
            </Button>
          </div>
        </div>

        {jellyfinResult && (
          <div className="mt-4 rounded-2xl border border-emerald-400/20 bg-emerald-400/5 p-4 text-sm">
            <div className="flex items-center gap-2 text-emerald-300">
              <CheckCircle2 size={17} /> {jellyfinResult.serverName}
              {jellyfinResult.version ? ` · ${jellyfinResult.version}` : ""}
            </div>
            <div className="mt-2 text-muted-foreground">
              {jellyfinResult.enabledUserCount}/{jellyfinResult.userCount} comptes actifs :{" "}
              {jellyfinResult.users
                .slice(0, 8)
                .map((user) => user.name)
                .join(", ")}
            </div>
          </div>
        )}

        <div className="mt-5 grid gap-3 rounded-2xl border border-border bg-card/50 p-4 text-sm md:grid-cols-3">
          <div>
            <strong>1. Créer la clé</strong>
            <p className="mt-1 text-xs text-muted-foreground">
              Jellyfin → Tableau de bord → Avancé → Clés API → Nouvelle clé.
            </p>
          </div>
          <div>
            <strong>2. Choisir l’adresse</strong>
            <p className="mt-1 text-xs text-muted-foreground">
              Même hôte : <code className="text-gold">http://host.docker.internal:8096</code>.
              N’utilisez pas <code>localhost</code> ni <code>/web</code>.
            </p>
          </div>
          <div>
            <strong>3. Tester puis activer</strong>
            <p className="mt-1 text-xs text-muted-foreground">
              Une activation est refusée tant que la clé et la liste des utilisateurs ne sont pas
              validées.
            </p>
          </div>
        </div>
        {data.jellyfin.source === "panel" && (
          <Button
            className="mt-4"
            size="sm"
            variant="ghost"
            disabled={jellyfinReset.isPending}
            onClick={() => jellyfinReset.mutate()}
          >
            Reprendre les valeurs de l’installateur
          </Button>
        )}
      </section>

      <section className="noir-panel rounded-3xl p-5 sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex gap-3">
            <div className="grid size-11 place-items-center rounded-2xl bg-cyan-400/10 text-cyan-300">
              <Send size={20} />
            </div>
            <div>
              <h2 className="font-display text-2xl">Relais SMTP sortant</h2>
              <p className="text-sm text-muted-foreground">
                Envoie vers Internet sans dépendre de la réputation de votre IP dynamique.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <StatePill
              ok={smtpVerified || data.smtp.enabled}
              text={smtpVerified ? "Test réussi" : data.smtp.enabled ? "Actif" : "Inactif"}
            />
            <Switch
              checked={smtpEnabled}
              onCheckedChange={setSmtpEnabled}
              aria-label="Activer le relais SMTP"
            />
          </div>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <label className="space-y-2 text-sm lg:col-span-2">
            <span>Serveur SMTP</span>
            <Input
              value={smtpHost}
              onChange={(e) => {
                setSmtpHost(e.target.value);
                setSmtpVerified(false);
              }}
              placeholder="smtp.votre-fournisseur.fr"
            />
          </label>
          <label className="space-y-2 text-sm">
            <span>Port</span>
            <select
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={smtpPort}
              onChange={(e) => {
                const port = Number(e.target.value) as 465 | 587;
                setSmtpPort(port);
                setSmtpSecurity(port === 465 ? "tls" : "starttls");
              }}
            >
              <option value={587}>587 · STARTTLS</option>
              <option value={465}>465 · TLS</option>
            </select>
          </label>
          <label className="space-y-2 text-sm">
            <span>Destinataires/message</span>
            <Input
              type="number"
              min={1}
              max={50}
              value={smtpMaxRecipients}
              onChange={(e) =>
                setSmtpMaxRecipients(Math.max(1, Math.min(50, Number(e.target.value) || 1)))
              }
            />
          </label>
          <label className="space-y-2 text-sm lg:col-span-2">
            <span>Identifiant SMTP</span>
            <Input
              value={smtpUsername}
              onChange={(e) => setSmtpUsername(e.target.value)}
              autoComplete="username"
            />
          </label>
          <label className="space-y-2 text-sm lg:col-span-2">
            <span>Mot de passe / clé SMTP</span>
            <Input
              type="password"
              value={smtpPassword}
              onChange={(e) => {
                setSmtpPassword(e.target.value);
                setSmtpVerified(false);
              }}
              autoComplete="new-password"
              placeholder={
                data.smtp.passwordSet ? "••••••••  laisser vide pour conserver" : "Secret SMTP"
              }
            />
          </label>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={!smtpReady || smtpTestMutation.isPending}
            onClick={() => smtpTestMutation.mutate()}
          >
            <ShieldCheck size={15} />{" "}
            {smtpTestMutation.isPending ? "Authentification…" : "Tester le relais"}
          </Button>
          <Button
            className="bg-gold text-background"
            disabled={(smtpEnabled && !smtpReady) || smtpSaveMutation.isPending}
            onClick={() => smtpSaveMutation.mutate()}
          >
            <KeyRound size={15} /> {smtpSaveMutation.isPending ? "Application…" : "Appliquer"}
          </Button>
          {data.smtp.source === "panel" && (
            <Button
              variant="ghost"
              disabled={smtpResetMutation.isPending}
              onClick={() => smtpResetMutation.mutate()}
            >
              Reprendre l’installateur
            </Button>
          )}
        </div>

        <div className="mt-5 grid gap-3 rounded-2xl border border-border bg-card/50 p-4 text-sm md:grid-cols-2 lg:grid-cols-4">
          <div>
            <strong>1. Ouvrir un relais</strong>
            <p className="mt-1 text-xs text-muted-foreground">
              Créez un compte chez le fournisseur SMTP de votre choix et ajoutez chacun de vos
              domaines.
            </p>
          </div>
          <div>
            <strong>2. Copier les accès</strong>
            <p className="mt-1 text-xs text-muted-foreground">
              Hôte public, port 587 STARTTLS ou 465 TLS, identifiant et mot de passe SMTP.
            </p>
          </div>
          <div>
            <strong>3. Authentifier les domaines</strong>
            <p className="mt-1 text-xs text-muted-foreground">
              Publiez exactement les TXT SPF, DKIM et DMARC fournis. Ne créez qu’un seul
              enregistrement SPF.
            </p>
          </div>
          <div>
            <strong>4. Vérifier l’envoi</strong>
            <p className="mt-1 text-xs text-muted-foreground">
              Testez ici, appliquez, puis envoyez un vrai message depuis « Nouveau message ». Aucun
              port 465/587 à ouvrir sur le routeur.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
