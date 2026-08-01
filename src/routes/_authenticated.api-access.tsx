import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { formatDistanceToNowStrict } from "date-fns";
import { fr } from "date-fns/locale";
import {
  Activity,
  Bot,
  CheckCircle2,
  Code2,
  Copy,
  Database,
  Globe2,
  Inbox,
  KeyRound,
  ListChecks,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";

import { ConfirmAction } from "@/components/confirm-action";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  createApiKey,
  deleteApiMailboxFromConsole,
  listApiActivityLogs,
  listApiKeys,
  listApiMailboxes,
  revokeApiKey,
} from "@/lib/api-access.functions";
import { copyText } from "@/lib/copy-text";

export const Route = createFileRoute("/_authenticated/api-access")({
  head: () => ({ meta: [{ title: "API — JorgardeMail" }] }),
  component: ApiAccessPage,
});

const ACTION_LABELS: Record<string, string> = {
  activity_logs_read: "Journaux consultés",
  api_access_granted: "Accès API accordé",
  api_access_revoked: "Accès API retiré",
  api_key_created: "Clé créée",
  api_key_revoked: "Clé révoquée",
  custom_mailbox_created: "Adresse personnalisée créée",
  domains_listed: "Domaines consultés",
  mailbox_creation_failed: "Création refusée",
  mailbox_deleted: "Adresse supprimée par API",
  mailbox_deleted_from_console: "Adresse supprimée depuis le panel",
  mailboxes_listed: "Adresses consultées",
  message_received: "Message reçu",
  messages_read: "Messages récupérés",
  random_mailbox_created: "Adresse aléatoire créée",
};

function ApiAccessPage() {
  const listKeys = useServerFn(listApiKeys);
  const listMailboxes = useServerFn(listApiMailboxes);
  const listLogs = useServerFn(listApiActivityLogs);
  const createKey = useServerFn(createApiKey);
  const revokeKey = useServerFn(revokeApiKey);
  const deleteMailbox = useServerFn(deleteApiMailboxFromConsole);
  const [name, setName] = useState("Mon outil");
  const [secret, setSecret] = useState<string | null>(null);

  const keysQuery = useQuery({ queryKey: ["api-keys"], queryFn: () => listKeys() });
  const mailboxesQuery = useQuery({
    queryKey: ["api-mailboxes"],
    queryFn: () => listMailboxes(),
    refetchInterval: 10_000,
  });
  const logsQuery = useQuery({
    queryKey: ["api-activity-logs"],
    queryFn: () => listLogs(),
    refetchInterval: 10_000,
  });

  const createMutation = useMutation({
    mutationFn: () => createKey({ data: { name } }),
    onSuccess: async (result) => {
      setSecret(result.secret);
      await Promise.all([keysQuery.refetch(), logsQuery.refetch()]);
      toast.success("Clé API créée");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Création impossible"),
  });
  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokeKey({ data: { id } }),
    onSuccess: async () => {
      await Promise.all([keysQuery.refetch(), logsQuery.refetch()]);
      toast.success("Clé révoquée");
    },
    onError: () => toast.error("Impossible de révoquer cette clé"),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteMailbox({ data: { id } }),
    onSuccess: async (mailbox) => {
      await Promise.all([mailboxesQuery.refetch(), logsQuery.refetch()]);
      toast.success(`${mailbox.address} supprimée définitivement`);
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Suppression impossible"),
  });

  if (keysQuery.isError || mailboxesQuery.isError || logsQuery.isError) {
    return (
      <div className="app-page text-muted-foreground">
        L’accès API n’est pas activé pour ce compte ou la migration serveur doit être installée.
      </div>
    );
  }

  const keys = keysQuery.data ?? [];
  const mailboxes = mailboxesQuery.data ?? [];
  const logs = logsQuery.data ?? [];
  const origin =
    typeof window === "undefined" ? "https://votre-jorgardemail" : window.location.origin;
  const aiPrompt = buildAiPrompt(origin);

  return (
    <div className="app-page">
      <PageHeader
        eyebrow="Automatisation privée"
        title="Console API"
        description="Créez jusqu’à 1 000 adresses permanentes isolées, recevez leurs messages et auditez chaque opération. Aucun envoi d’e-mail n’est possible."
        actions={
          <div className="premium-badge normal-case tracking-normal">
            <ShieldCheck className="size-4" /> Réception uniquement
          </div>
        }
      />

      <div className="grid gap-5 xl:grid-cols-[0.75fr_1.25fr]">
        <section className="noir-panel rounded-3xl p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="premium-kicker">Authentification</div>
              <h2 className="mt-1 font-display text-2xl">Clés d’accès</h2>
            </div>
            <span className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground">
              {keys.length}/5
            </span>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Une clé complète n’est visible qu’une fois. Elle donne accès uniquement aux ressources
            API de ce compte.
          </p>
          <div className="mt-5 flex gap-2">
            <Input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
            <Button
              className="bg-gold text-white"
              disabled={!name.trim() || createMutation.isPending || keys.length >= 5}
              onClick={() => createMutation.mutate()}
            >
              <Plus className="size-4" /> Créer
            </Button>
          </div>
          {secret && (
            <div className="mt-4 rounded-2xl border border-amber-300/25 bg-amber-300/[0.07] p-4">
              <div className="text-xs font-bold uppercase tracking-wider text-amber-200">
                À copier maintenant
              </div>
              <code className="mt-2 block break-all text-sm text-white">{secret}</code>
              <Button
                size="sm"
                variant="outline"
                className="mt-3"
                onClick={() => void copyWithToast(secret, "Clé copiée")}
              >
                <Copy className="size-4" /> Copier
              </Button>
            </div>
          )}
          <div className="mt-5 space-y-2">
            {keys.map((key) => (
              <div
                key={key.id}
                className="flex items-center gap-3 rounded-2xl border border-border bg-black/10 p-3"
              >
                <KeyRound className="size-4 text-brand-secondary" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{key.name}</div>
                  <div className="font-mono text-xs text-muted-foreground">
                    {key.key_prefix}••••••
                  </div>
                </div>
                <ConfirmAction
                  title={`Révoquer la clé « ${key.name} » ?`}
                  description="Tous les outils utilisant cette clé perdront immédiatement leur accès."
                  confirmLabel="Révoquer"
                  onConfirm={() => revokeMutation.mutate(key.id)}
                >
                  <Button variant="ghost" size="icon" aria-label={`Révoquer ${key.name}`}>
                    <Trash2 className="size-4" />
                  </Button>
                </ConfirmAction>
              </div>
            ))}
          </div>
        </section>

        <section className="noir-panel rounded-3xl p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="premium-kicker">Adresses isolées</div>
              <h2 className="mt-1 font-display text-2xl">Créées avec l’API</h2>
            </div>
            <div className="rounded-2xl border border-brand-secondary/20 bg-brand-secondary/[0.06] px-4 py-2 text-right">
              <div className="font-display text-2xl text-brand-secondary">{mailboxes.length}</div>
              <div className="text-[0.65rem] uppercase tracking-wider text-muted-foreground">
                sur 1 000
              </div>
            </div>
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Ces adresses sont permanentes et ne consomment pas votre quota de boîtes personnelles.
            Leurs messages ne sont lisibles que par l’API.
          </p>
          <div className="mt-5 max-h-[28rem] space-y-2 overflow-y-auto pr-1">
            {mailboxesQuery.isLoading && (
              <div className="rounded-2xl border border-border p-5 text-sm text-muted-foreground">
                Chargement des adresses API…
              </div>
            )}
            {!mailboxesQuery.isLoading && mailboxes.length === 0 && (
              <div className="rounded-2xl border border-dashed border-border p-7 text-center text-sm text-muted-foreground">
                <Inbox className="mx-auto mb-3 size-7 text-brand-secondary/70" />
                Aucune adresse API. Utilisez <code>POST /mailboxes</code> pour en créer une.
              </div>
            )}
            {mailboxes.map((mailbox) => (
              <div
                key={mailbox.id}
                className="flex items-center gap-3 rounded-2xl border border-border bg-black/10 px-3 py-2.5"
              >
                <span className="size-2 shrink-0 rounded-full bg-emerald-300 shadow-[0_0_12px_rgba(110,231,183,.5)]" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-xs text-foreground sm:text-sm">
                    {mailbox.address}
                  </div>
                  <div className="text-[0.68rem] text-muted-foreground">
                    créée{" "}
                    {formatDistanceToNowStrict(new Date(mailbox.created_at), {
                      addSuffix: true,
                      locale: fr,
                    })}
                  </div>
                </div>
                <span className="hidden rounded-full border border-border px-2 py-0.5 text-[0.62rem] uppercase tracking-wider text-muted-foreground sm:inline">
                  API
                </span>
                <ConfirmAction
                  title={`Supprimer ${mailbox.address} ?`}
                  description="L’adresse, tous ses messages et toutes ses pièces jointes seront supprimés définitivement."
                  confirmLabel="Supprimer définitivement"
                  onConfirm={() => deleteMutation.mutate(mailbox.id)}
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-red-300"
                    aria-label={`Supprimer ${mailbox.address}`}
                    disabled={deleteMutation.isPending}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </ConfirmAction>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="noir-panel mt-5 rounded-3xl p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="premium-kicker">Audit</div>
            <h2 className="mt-1 font-display text-2xl">Activité de l’API</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Les secrets, le corps des messages et les pièces jointes ne sont jamais écrits dans
              les logs.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void logsQuery.refetch()}>
            <Activity className="size-4" /> Actualiser
          </Button>
        </div>
        <div className="mt-5 overflow-x-auto rounded-2xl border border-border">
          <table className="w-full min-w-[48rem] text-left text-sm">
            <thead className="bg-black/20 text-[0.67rem] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Évènement</th>
                <th className="px-4 py-3">Adresse</th>
                <th className="px-4 py-3">Clé</th>
                <th className="px-4 py-3">IP</th>
                <th className="px-4 py-3">Statut</th>
                <th className="px-4 py-3">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {logs.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    Aucun évènement enregistré.
                  </td>
                </tr>
              )}
              {logs.map((log) => (
                <tr key={log.id} className="bg-black/[0.04]">
                  <td className="px-4 py-3 font-medium">
                    {ACTION_LABELS[log.action] ?? log.action}
                  </td>
                  <td className="max-w-64 truncate px-4 py-3 font-mono text-xs text-muted-foreground">
                    {log.address ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {log.api_key?.name ?? "Console"}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                    {log.client_ip ?? "locale"}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        log.status < 400
                          ? "bg-emerald-300/10 text-emerald-200"
                          : "bg-red-300/10 text-red-200"
                      }`}
                    >
                      {log.status}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
                    {new Date(log.created_at).toLocaleString("fr-FR")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="noir-panel mt-5 rounded-3xl border-brand-secondary/15 p-5 sm:p-7">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <div className="grid size-12 shrink-0 place-items-center rounded-2xl bg-brand-secondary/10 text-brand-secondary ring-1 ring-brand-secondary/20">
              <Bot className="size-5" />
            </div>
            <div>
              <div className="premium-kicker">Intégration assistée</div>
              <h2 className="mt-1 font-display text-2xl">Prompt complet pour une IA</h2>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
                Copiez un cahier des charges contenant toutes les routes, règles de sécurité,
                exemples et réponses attendues. La clé API n’est volontairement pas incluse.
              </p>
            </div>
          </div>
          <Button
            className="shrink-0 bg-gold text-white"
            onClick={() => void copyWithToast(aiPrompt, "Prompt d’intégration copié")}
          >
            <Copy className="size-4" /> Copier le prompt IA
          </Button>
        </div>
      </section>

      <ApiDocumentation origin={origin} />
    </div>
  );
}

async function copyWithToast(value: string, message: string) {
  await copyText(value);
  toast.success(message);
}

function buildAiPrompt(origin: string): string {
  return `Intègre l’API de réception JorgardeMail dans mon application.

URL de base: ${origin}/api/v1
Authentification: ajoute "Authorization: Bearer VOTRE_CLE" à chaque requête.
Toutes les requêtes et réponses utilisent JSON. Ne mets jamais la clé côté client public, dans les logs ou dans Git.

Fonctionnalités disponibles:
1. GET /domains — retourne { domains: [{ id, name }], total }.
2. GET /mailboxes — liste uniquement les adresses créées par l’API et retourne { mailboxes, total, maximum: 1000 }.
3. POST /mailboxes avec {} — crée une adresse aléatoire permanente sur un domaine actif.
4. POST /mailboxes avec { "local_part": "nom", "domain": "exemple.com" } — crée une adresse personnalisée. domain et local_part sont optionnels indépendamment. Gère address_already_exists.
5. GET /mailboxes/{id}/messages?limit=100&before=DATE_ISO — récupère les messages reçus, avec pagination par pagination.next_before. Répète jusqu’à ce que next_before soit null. Il n’existe aucun quota horaire de lecture.
6. DELETE /mailboxes/{id} — supprime définitivement l’adresse et ses messages.
7. GET /logs?limit=100 — retourne le journal d’activité du propriétaire.

Règles impératives:
- Il n’existe et il ne doit exister AUCUNE fonctionnalité d’envoi d’e-mail.
- Maximum 1 000 adresses API existantes simultanément; supprimer une adresse libère une place.
- Les adresses API sont permanentes, sans TTL, et isolées des boîtes personnelles.
- Il n’y a aucune limite de créations par heure ni de lectures par minute.
- body_html est du contenu Internet non fiable: assainis-le avec une bibliothèque reconnue puis affiche-le dans une iframe sandboxée. N’utilise jamais directement innerHTML.
- Les pièces jointes retournées sont uniquement des métadonnées; aucun contenu binaire n’est exposé par cette API.
- Gère les HTTP 400, 401, 403, 404, 409, 413 et 500 avec des messages explicites.
- Utilise des délais réseau, des reprises uniquement sur les erreurs temporaires et ne reprends jamais automatiquement une création après une réponse 409.

Produis le client API typé, la gestion d’erreurs, la pagination complète et des tests. Demande-moi séparément la clé API au moment de configurer le secret.`;
}

function ApiDocumentation({ origin }: { origin: string }) {
  const bearer = `-H "Authorization: Bearer VOTRE_CLE"`;
  return (
    <section className="noir-panel mt-5 rounded-3xl p-5 sm:p-7">
      <div className="flex flex-col gap-4 border-b border-border pb-6 sm:flex-row sm:items-start">
        <div className="grid size-12 shrink-0 place-items-center rounded-2xl bg-brand-secondary/10 text-brand-secondary ring-1 ring-brand-secondary/20">
          <Database className="size-5" />
        </div>
        <div>
          <div className="premium-kicker">Référence complète</div>
          <h2 className="mt-1 font-display text-3xl">Documentation API</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            URL de base : <code>{origin}/api/v1</code>. Réponses JSON, sans cache. Aucun endpoint
            d’envoi n’existe.
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-4">
        <DocFact
          icon={<ShieldCheck className="size-4" />}
          title="Authentification"
          body="Bearer jm_… sur chaque requête. Révocation immédiate."
        />
        <DocFact
          icon={<Globe2 className="size-4" />}
          title="Adresses"
          body="Aléatoires ou personnalisées, permanentes, maximum 1 000 actives."
        />
        <DocFact
          icon={<ListChecks className="size-4" />}
          title="Sans rate limit"
          body="Aucun quota horaire de création et aucun quota de lecture."
        />
        <DocFact
          icon={<CheckCircle2 className="size-4" />}
          title="Périmètre"
          body="Réception, consultation, suppression et audit uniquement."
        />
      </div>

      <div className="mt-8 space-y-9">
        <ApiEndpoint
          method="GET"
          path="/domains"
          description="Énumère les domaines actifs utilisables."
        >
          <ApiExample title="Requête" code={`curl "${origin}/api/v1/domains" \\\n  ${bearer}`} />
          <ApiExample
            title="Réponse 200"
            code={`{ "domains": [{ "id": "…", "name": "jorgarde.lol" }], "total": 1 }`}
          />
        </ApiEndpoint>

        <ApiEndpoint
          method="GET"
          path="/mailboxes"
          description="Liste toutes les adresses API du propriétaire et le nombre de places utilisées."
        >
          <ApiExample title="Requête" code={`curl "${origin}/api/v1/mailboxes" \\\n  ${bearer}`} />
          <ApiExample
            title="Réponse 200"
            code={`{
  "mailboxes": [{
    "id": "2ed84e6a-5e30-4a0e-8e2f-c97ad3ae4242",
    "address": "api-a94f@jorgarde.lol",
    "created_at": "2026-08-01T20:00:00.000Z"
  }],
  "total": 1,
  "maximum": 1000
}`}
          />
        </ApiEndpoint>

        <ApiEndpoint
          method="POST"
          path="/mailboxes"
          description="Crée une adresse permanente. Un corps vide choisit un nom et un domaine aléatoires."
        >
          <ApiExample
            title="Création aléatoire"
            code={`curl -X POST "${origin}/api/v1/mailboxes" \\\n  ${bearer} \\\n  -H "Content-Type: application/json" \\\n  -d '{}'`}
          />
          <ApiExample
            title="Création personnalisée"
            code={`curl -X POST "${origin}/api/v1/mailboxes" \\\n  ${bearer} \\\n  -H "Content-Type: application/json" \\\n  -d '{"local_part":"robot","domain":"jorgarde.lol"}'`}
          />
          <p className="text-xs leading-5 text-muted-foreground xl:col-span-2">
            <code>local_part</code> et <code>domain</code> sont optionnels. Une adresse existante
            retourne <code>409 address_already_exists</code>. La suppression d’une adresse libère
            immédiatement une place.
          </p>
        </ApiEndpoint>

        <ApiEndpoint
          method="GET"
          path="/mailboxes/{id}/messages?limit=100&before={date_iso}"
          description="Lit les messages reçus. La pagination permet de parcourir un historique sans quota de lecture."
        >
          <ApiExample
            title="Requête"
            code={`curl "${origin}/api/v1/mailboxes/ID/messages?limit=100" \\\n  ${bearer}`}
          />
          <ApiExample
            title="Réponse 200"
            code={`{
  "mailbox": { "id": "…", "address": "robot@jorgarde.lol", "created_at": "…" },
  "messages": [{
    "id": "…", "sender": "source@example.net", "subject": "Bienvenue",
    "body_text": "Contenu", "body_html": "<p>Contenu non fiable</p>",
    "received_at": "…", "attachments": []
  }],
  "pagination": { "limit": 100, "next_before": null }
}`}
          />
          <p className="text-xs leading-5 text-muted-foreground xl:col-span-2">
            <code>limit</code> accepte 1 à 500. Utilisez <code>next_before</code> comme paramètre
            <code>before</code> suivant jusqu’à obtenir <code>null</code>. Cela limite uniquement la
            taille d’une réponse, jamais le nombre de lectures.
          </p>
        </ApiEndpoint>

        <ApiEndpoint
          method="DELETE"
          path="/mailboxes/{id}"
          description="Supprime définitivement l’adresse, ses messages et ses pièces jointes."
        >
          <ApiExample
            title="Requête"
            code={`curl -X DELETE "${origin}/api/v1/mailboxes/ID" \\\n  ${bearer}`}
          />
          <ApiExample
            title="Réponse 200"
            code={`{ "deleted": true, "mailbox": { "id": "…", "address": "robot@jorgarde.lol" } }`}
          />
        </ApiEndpoint>

        <ApiEndpoint
          method="GET"
          path="/logs?limit=100"
          description="Consulte les derniers évènements d’audit du compte."
        >
          <ApiExample
            title="Requête"
            code={`curl "${origin}/api/v1/logs?limit=100" \\\n  ${bearer}`}
          />
          <ApiExample
            title="Réponse 200"
            code={`{ "logs": [{
  "action": "messages_read", "address": "robot@jorgarde.lol",
  "status": 200, "client_ip": "10.0.0.2", "created_at": "…"
}], "total_returned": 1 }`}
          />
        </ApiEndpoint>
      </div>

      <div className="mt-8 grid gap-5 lg:grid-cols-2">
        <div className="rounded-2xl border border-border bg-black/10 p-5">
          <h3 className="font-semibold">Codes d’erreur</h3>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[30rem] text-left text-sm">
              <tbody className="divide-y divide-border">
                {[
                  ["400", "invalid_request / invalid_local_part", "Requête ou nom invalide"],
                  ["401", "unauthorized", "Clé absente, invalide ou révoquée"],
                  ["403", "forbidden", "Accès API retiré ou compte suspendu"],
                  ["404", "mailbox_not_found", "Adresse inconnue ou d’un autre propriétaire"],
                  ["409", "address_already_exists", "Cette adresse existe déjà"],
                  ["409", "api_mailbox_limit_reached", "1 000 adresses actives atteintes"],
                  ["409", "domain_unavailable", "Domaine absent ou expiré"],
                  ["413", "payload_too_large", "Corps trop volumineux"],
                  ["500", "internal_error", "Erreur serveur inattendue"],
                ].map(([status, error, meaning]) => (
                  <tr key={`${status}-${error}`}>
                    <td className="py-2 pr-4 font-mono text-brand-secondary">{status}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{error}</td>
                    <td className="py-2 text-muted-foreground">{meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-2xl border border-emerald-300/15 bg-emerald-300/[0.05] p-5">
          <div className="flex items-center gap-2 font-semibold text-emerald-100">
            <Code2 className="size-4" /> Garanties
          </div>
          <ul className="mt-4 space-y-3 text-sm leading-6 text-muted-foreground">
            <li>• Aucun rate limit de création ou de lecture.</li>
            <li>• Adresses permanentes, sans date d’expiration.</li>
            <li>• Plafond atomique de 1 000 adresses simultanées par propriétaire.</li>
            <li>• Isolation de la messagerie personnelle appliquée dans PostgreSQL.</li>
            <li>• Les journaux n’enregistrent jamais les clés ou le contenu reçu.</li>
            <li>• Aucun endpoint d’envoi d’e-mail n’existe.</li>
          </ul>
        </div>
      </div>
    </section>
  );
}

function DocFact({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-border bg-black/10 p-4">
      <div className="flex items-center gap-2 font-semibold text-foreground">
        <span className="text-brand-secondary">{icon}</span> {title}
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{body}</p>
    </div>
  );
}

function ApiEndpoint({
  method,
  path,
  description,
  children,
}: {
  method: "GET" | "POST" | "DELETE";
  path: string;
  description: string;
  children: ReactNode;
}) {
  const tone =
    method === "GET"
      ? "bg-sky-300/10 text-sky-200 ring-sky-300/20"
      : method === "DELETE"
        ? "bg-red-300/10 text-red-200 ring-red-300/20"
        : "bg-emerald-300/10 text-emerald-200 ring-emerald-300/20";
  return (
    <article>
      <div className="flex flex-wrap items-center gap-3">
        <span className={`rounded-lg px-2.5 py-1 font-mono text-xs font-black ring-1 ${tone}`}>
          {method}
        </span>
        <code className="break-all text-sm font-semibold sm:text-base">{path}</code>
      </div>
      <p className="mt-3 max-w-4xl text-sm leading-6 text-muted-foreground">{description}</p>
      <div className="mt-4 grid gap-4 xl:grid-cols-2">{children}</div>
    </article>
  );
}

function ApiExample({ title, code }: { title: string; code: string }) {
  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-center justify-between gap-3 font-semibold">
        <span>{title}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 text-xs text-muted-foreground"
          onClick={() => void copyWithToast(code, "Exemple copié")}
        >
          <Copy className="size-3" /> Copier
        </Button>
      </div>
      <pre className="max-h-96 overflow-auto rounded-2xl bg-[#080b12] p-4 text-xs leading-6 text-slate-300">
        <code>{code}</code>
      </pre>
    </div>
  );
}
