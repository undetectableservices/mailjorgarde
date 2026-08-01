import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Code2,
  Copy,
  Database,
  KeyRound,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createApiKey, listApiKeys, revokeApiKey } from "@/lib/api-access.functions";
import { copyText } from "@/lib/copy-text";

export const Route = createFileRoute("/_authenticated/api-access")({
  head: () => ({ meta: [{ title: "API — JorgardeMail" }] }),
  component: ApiAccessPage,
});

function ApiAccessPage() {
  const list = useServerFn(listApiKeys);
  const create = useServerFn(createApiKey);
  const revoke = useServerFn(revokeApiKey);
  const [name, setName] = useState("Mon outil");
  const [secret, setSecret] = useState<string | null>(null);
  const {
    data: keys = [],
    refetch,
    isError,
  } = useQuery({ queryKey: ["api-keys"], queryFn: () => list() });
  const createMutation = useMutation({
    mutationFn: () => create({ data: { name } }),
    onSuccess: (result) => {
      setSecret(result.secret);
      void refetch();
      toast.success("Clé API créée");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Création impossible"),
  });
  const revokeMutation = useMutation({
    mutationFn: (id: string) => revoke({ data: { id } }),
    onSuccess: () => {
      void refetch();
      toast.success("Clé révoquée");
    },
  });

  if (isError) {
    return (
      <div className="app-page text-muted-foreground">
        L’accès API n’est pas activé pour ce compte.
      </div>
    );
  }

  const origin =
    typeof window === "undefined" ? "https://votre-jorgardemail" : window.location.origin;
  return (
    <div className="app-page">
      <PageHeader
        eyebrow="Automatisation sécurisée"
        title="API développeur"
        description="Créez des adresses temporaires et consultez leurs messages. Cette API ne permet jamais d’envoyer des e-mails."
        actions={
          <div className="premium-badge normal-case tracking-normal">
            <Code2 className="size-4" /> Lecture seule
          </div>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
        <section className="noir-panel rounded-3xl p-5 sm:p-6">
          <h2 className="font-display text-2xl">Clés d’accès</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Maximum 5 clés. Une clé n’est affichée qu’une seule fois.
          </p>
          <div className="mt-5 flex gap-2">
            <Input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
            <Button
              className="bg-gold text-white"
              disabled={!name.trim() || createMutation.isPending}
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
                onClick={() => void copyText(secret)}
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
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Révoquer ${key.name}`}
                  onClick={() => revokeMutation.mutate(key.id)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        </section>

        <section className="noir-panel rounded-3xl p-5 sm:p-6">
          <h2 className="font-display text-2xl">Démarrage rapide</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Envoyez la clé dans <code>Authorization: Bearer …</code>.
          </p>
          <div className="mt-5 space-y-4 text-sm">
            <ApiExample
              title="Créer une adresse (1 heure)"
              code={`curl -X POST "${origin}/api/v1/mailboxes" \\\n  -H "Authorization: Bearer VOTRE_CLE" \\\n  -H "Content-Type: application/json" \\\n  -d '{"ttl_minutes":60}'`}
            />
            <ApiExample
              title="Lire les messages"
              code={`curl "${origin}/api/v1/mailboxes/ID/messages?limit=50" \\\n  -H "Authorization: Bearer VOTRE_CLE"`}
            />
          </div>
          <div className="mt-5 rounded-2xl border border-emerald-300/15 bg-emerald-300/[0.06] p-4 text-sm text-emerald-100">
            Aucun endpoint d’envoi n’existe. Les pièces jointes sont retournées en métadonnées
            uniquement.
          </div>
        </section>
      </div>

      <ApiDocumentation origin={origin} />
    </div>
  );
}

function ApiDocumentation({ origin }: { origin: string }) {
  const createResponse = `{
  "mailbox": {
    "id": "2ed84e6a-5e30-4a0e-8e2f-c97ad3ae4242",
    "address": "api-a94f...@example.com",
    "expires_at": "2026-08-01T20:00:00.000Z"
  }
}`;
  const messagesResponse = `{
  "mailbox": {
    "id": "2ed84e6a-5e30-4a0e-8e2f-c97ad3ae4242",
    "address": "api-a94f...@example.com",
    "expires_at": "2026-08-01T20:00:00.000Z"
  },
  "messages": [{
    "id": "...",
    "sender": "sender@example.net",
    "recipient_addr": "api-a94f...@example.com",
    "subject": "Bienvenue",
    "body_text": "Contenu texte",
    "body_html": "<p>Contenu HTML non fiable</p>",
    "received_at": "2026-08-01T19:02:00.000Z",
    "size_bytes": 1240,
    "attachments": [{
      "id": "...",
      "filename": "document.pdf",
      "mime": "application/pdf",
      "size": 45210
    }]
  }]
}`;

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
            URL de base: <code>{origin}/api/v1</code>. Toutes les réponses sont en JSON et les clés
            doivent rester secrètes. Une clé révoquée cesse immédiatement de fonctionner.
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <DocFact
          icon={<ShieldCheck className="size-4" />}
          title="Authentification"
          body="Authorization: Bearer jm_… sur chaque requête."
        />
        <DocFact
          icon={<Clock3 className="size-4" />}
          title="Durée"
          body="Une adresse vit entre 10 et 1 440 minutes. Valeur par défaut: 60."
        />
        <DocFact
          icon={<CheckCircle2 className="size-4" />}
          title="Périmètre"
          body="Création d’adresses temporaires et lecture des messages reçus uniquement."
        />
      </div>

      <div className="mt-8 space-y-8">
        <ApiEndpoint
          method="POST"
          path="/mailboxes"
          description="Crée une adresse aléatoire temporaire sur l’un des domaines actifs. Elle compte dans votre quota d’adresses."
        >
          <ApiExample
            title="Requête"
            code={`curl -X POST "${origin}/api/v1/mailboxes" \\\n  -H "Authorization: Bearer VOTRE_CLE" \\\n  -H "Content-Type: application/json" \\\n  -d '{"ttl_minutes":60}'`}
          />
          <ApiExample title="Réponse 201" code={createResponse} />
          <p className="text-xs leading-5 text-muted-foreground">
            Corps JSON strict: <code>ttl_minutes</code> est optionnel, entier, entre 10 et 1 440.
            Aucun nom d’adresse personnalisé n’est accepté.
          </p>
        </ApiEndpoint>

        <ApiEndpoint
          method="GET"
          path="/mailboxes/{id}/messages?limit=50"
          description="Retourne les messages reçus par une adresse créée avec la même clé utilisateur. Les plus récents arrivent en premier."
        >
          <ApiExample
            title="Requête"
            code={`curl "${origin}/api/v1/mailboxes/ID/messages?limit=50" \\\n  -H "Authorization: Bearer VOTRE_CLE"`}
          />
          <ApiExample title="Réponse 200" code={messagesResponse} />
          <p className="text-xs leading-5 text-muted-foreground">
            <code>limit</code> accepte 1 à 100 éléments et vaut 50 par défaut. Le contenu des pièces
            jointes n’est jamais exposé: seules leurs métadonnées sont retournées.
          </p>
        </ApiEndpoint>
      </div>

      <div className="mt-8 grid gap-5 lg:grid-cols-2">
        <div className="rounded-2xl border border-border bg-black/10 p-5">
          <h3 className="font-semibold">Codes d’erreur</h3>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[30rem] text-left text-sm">
              <thead className="text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="pb-2 pr-4">HTTP</th>
                  <th className="pb-2 pr-4">Erreur</th>
                  <th className="pb-2">Signification</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {[
                  ["400", "invalid_request", "Paramètres ou identifiant invalides"],
                  ["401", "unauthorized", "Clé absente, invalide, révoquée ou accès retiré"],
                  ["404", "mailbox_not_found", "Adresse inconnue ou appartenant à un autre compte"],
                  ["409", "mailbox_limit_reached", "Quota d’adresses atteint"],
                  ["409", "no_domain_available", "Aucun domaine actif disponible"],
                  ["410", "mailbox_expired", "Adresse arrivée à expiration"],
                  ["413", "payload_too_large", "Corps de requête trop volumineux"],
                  ["429", "rate_limited", "Limite temporaire dépassée"],
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

        <div className="rounded-2xl border border-amber-300/20 bg-amber-300/[0.05] p-5">
          <div className="flex items-center gap-2 font-semibold text-amber-100">
            <AlertTriangle className="size-4" /> Sécurité et limites
          </div>
          <ul className="mt-4 space-y-3 text-sm leading-6 text-muted-foreground">
            <li>• 20 créations d’adresse par heure et par clé.</li>
            <li>• 180 lectures par minute et par clé.</li>
            <li>• Maximum 5 clés actives par utilisateur.</li>
            <li>
              • <code>body_html</code> provient d’expéditeurs externes: assainissez-le et
              affichez-le dans une iframe isolée. Ne l’injectez jamais directement dans votre page.
            </li>
            <li>• Ne placez jamais une clé dans du JavaScript public ou un dépôt Git.</li>
            <li>• Il n’existe volontairement aucune route permettant d’envoyer un e-mail.</li>
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
  method: "GET" | "POST";
  path: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <article>
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`rounded-lg px-2.5 py-1 font-mono text-xs font-black ${
            method === "GET"
              ? "bg-sky-300/10 text-sky-200 ring-1 ring-sky-300/20"
              : "bg-emerald-300/10 text-emerald-200 ring-1 ring-emerald-300/20"
          }`}
        >
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
          onClick={() => void copyText(code)}
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
