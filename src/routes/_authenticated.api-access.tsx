import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Code2, Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
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
          <h2 className="font-display text-2xl">Utilisation</h2>
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
    </div>
  );
}

function ApiExample({ title, code }: { title: string; code: string }) {
  return (
    <div>
      <div className="mb-2 font-semibold">{title}</div>
      <pre className="overflow-x-auto rounded-2xl bg-[#080b12] p-4 text-xs leading-6 text-slate-300">
        {code}
      </pre>
    </div>
  );
}
