import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { copyText } from "@/lib/copy-text";
import {
  checkBackend,
  checkDns,
  checkOutboundRelay,
  checkServerEnv,
  checkSmtpListener,
  sendTestDelivery,
} from "@/lib/setup-tests.functions";

type DnsCheck = { ok: boolean; found: string[]; loading: boolean };
type PillState = "idle" | "run" | "ok" | "fail";
type PortCheck = {
  loading?: boolean;
  open?: boolean;
  banner?: string;
  error?: string;
};

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function CopyBtn({ value }: { value: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await copyText(value);
          setOk(true);
          setTimeout(() => setOk(false), 1200);
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "La copie a échoué");
        }
      }}
      className="text-xs px-2 py-1 rounded border border-border hover:border-gold hover:text-gold transition-colors"
    >
      {ok ? "Copié" : "Copier"}
    </button>
  );
}

function Pill({ state, label }: { state: PillState; label?: string }) {
  const tone =
    state === "ok"
      ? "text-emerald-400 border-emerald-400/40 bg-emerald-400/10"
      : state === "fail"
        ? "text-red-400 border-red-400/40 bg-red-400/10"
        : state === "run"
          ? "text-gold border-gold/40 bg-gold/10"
          : "text-muted-foreground border-border";
  const txt =
    label ??
    (state === "ok"
      ? "Réussi"
      : state === "fail"
        ? "Échec"
        : state === "run"
          ? "Vérification…"
          : "Non vérifié");
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded-full border whitespace-nowrap ${tone}`}>
      {txt}
    </span>
  );
}

const PORTS = [
  {
    port: 25,
    label: "Réception SMTP locale (publiée en TCP 25)",
    why: "Vérifie le service SMTP de cette installation. L’accès depuis Internet doit ensuite être testé depuis un réseau extérieur.",
    banner: true,
  },
];

export function SetupWizard() {
  const [step, setStep] = useState(0);
  const [newDomain, setNewDomain] = useState("");
  const [selectedDomain, setSelectedDomain] = useState<string>("");
  const [checks, setChecks] = useState<Record<string, DnsCheck>>({});
  const [portResults, setPortResults] = useState<Record<number, PortCheck>>({});
  const [testAddr, setTestAddr] = useState("");

  const runEnv = useServerFn(checkServerEnv);
  const runPort = useServerFn(checkSmtpListener);
  const runDns = useServerFn(checkDns);
  const runOutbound = useServerFn(checkOutboundRelay);
  const runDelivery = useServerFn(sendTestDelivery);
  const runBackend = useServerFn(checkBackend);

  const {
    data: env,
    refetch: refetchEnv,
    isFetching: envLoading,
  } = useQuery({
    queryKey: ["setup-env"],
    queryFn: () => runEnv(),
  });
  const serverIp = env?.ip ?? "";
  const mailHostname = env?.mailHostname ?? "";

  const {
    data: health,
    refetch: refetchHealth,
    isFetching: healthLoading,
  } = useQuery({
    queryKey: ["setup-health"],
    queryFn: () => runBackend(),
  });

  const { data: domains, refetch: refetchDomains } = useQuery({
    queryKey: ["setup-domains"],
    queryFn: async () => (await supabase.from("domains").select("*").order("name")).data ?? [],
  });

  useEffect(() => {
    if (!selectedDomain && domains && domains.length > 0) setSelectedDomain(domains[0].name);
  }, [domains, selectedDomain]);

  const addDomain = useMutation({
    mutationFn: async () => {
      const n = newDomain.trim().toLowerCase();
      if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(n)) {
        throw new Error("Saisissez un domaine valide, par exemple exemple.fr");
      }
      const { error } = await supabase.from("domains").insert({ name: n });
      if (error) throw new Error("Ce domaine existe déjà ou ne peut pas être ajouté");
    },
    onSuccess: () => {
      setNewDomain("");
      refetchDomains();
      toast.success("Domaine ajouté");
    },
    onError: (error) => toast.error(getErrorMessage(error, "Impossible d’ajouter le domaine")),
  });

  const testPort = async (port: number, banner: boolean) => {
    setPortResults((r) => ({ ...r, [port]: { loading: true } }));
    try {
      const res = await runPort({ data: { banner } });
      setPortResults((r) => ({ ...r, [port]: res }));
    } catch {
      setPortResults((r) => ({
        ...r,
        [port]: { loading: false, open: false, error: "Le test local a échoué" },
      }));
    }
  };

  const testAllPorts = async () => {
    for (const p of PORTS) await testPort(p.port, p.banner);
  };

  const delivery = useMutation({
    mutationFn: async () => runDelivery({ data: { to: testAddr.trim() } }),
    onSuccess: (r) => {
      toast.success(`Message de test livré à ${r.to} — consultez la boîte de réception.`);
      refetchHealth();
    },
    onError: (error) => toast.error(getErrorMessage(error, "Le test de réception a échoué")),
  });

  const outboundCheck = useMutation({
    mutationFn: () => runOutbound(),
    onSuccess: (result) => {
      if (result.enabled && result.configured) {
        toast.success("Relais SMTP authentifié et prêt à envoyer");
      } else {
        toast.info("L'envoi externe est désactivé dans la configuration du serveur");
      }
    },
    onError: (error) => toast.error(getErrorMessage(error, "La connexion au relais SMTP a échoué")),
  });

  const runCheck = async (
    key: string,
    name: string,
    type: "A" | "AAAA" | "MX" | "TXT",
    predicate: (records: string[]) => boolean,
  ) => {
    setChecks((c) => ({ ...c, [key]: { ok: false, found: [], loading: true } }));
    try {
      const result = await runDns({ data: { name, type } });
      const found = result.records;
      setChecks((c) => ({ ...c, [key]: { ok: predicate(found), found, loading: false } }));
    } catch {
      setChecks((c) => ({ ...c, [key]: { ok: false, found: [], loading: false } }));
    }
  };

  const checkAll = async (d: string) => {
    const mx = mailHostname.toLowerCase().replace(/\.$/, "");
    await Promise.all([
      runCheck(
        `${d}:MX`,
        d,
        "MX",
        (records) =>
          Boolean(mx) && records.some((record) => record.toLowerCase().split(/\s+/).at(-1) === mx),
      ),
      runCheck(
        `${d}:MAIL_A`,
        mailHostname,
        "A",
        (records) => records.length > 0 && (!serverIp || records.includes(serverIp)),
      ),
      runCheck(`${d}:MAIL_AAAA`, mailHostname, "AAAA", (records) => records.length > 0),
    ]);
  };

  const steps = [
    "Bienvenue",
    "Serveur",
    "Ports",
    "Domaines",
    "DNS",
    "Vérification",
    "Tests",
    "Terminé",
  ];

  return (
    <div className="space-y-6">
      {/* Progress rail */}
      <div className="noir-panel rounded-3xl p-4">
        <div className="flex items-center gap-2 flex-wrap">
          {steps.map((s, i) => (
            <button key={s} onClick={() => setStep(i)} className="flex items-center gap-2 group">
              <span
                className={`w-7 h-7 rounded-full grid place-items-center text-xs font-medium transition-all ${i === step ? "bg-gold text-background glow-gold" : i < step ? "bg-gold/20 text-gold" : "bg-muted text-muted-foreground"}`}
              >
                {i < step ? "✓" : i + 1}
              </span>
              <span
                className={`text-sm ${i === step ? "text-gold" : "text-muted-foreground"} hidden lg:inline`}
              >
                {s}
              </span>
              {i < steps.length - 1 && <span className="w-6 h-px bg-border hidden lg:block" />}
            </button>
          ))}
        </div>
      </div>

      {step === 0 && (
        <div className="noir-panel rounded-3xl p-8 space-y-4">
          <h2 className="font-display text-3xl text-gold">Configurer JorgardeMail</h2>
          <p className="text-muted-foreground">
            Cet assistant vérifie votre installation, la réception depuis Internet et l’envoi via
            votre relais SMTP, tout en conservant l’application sur votre réseau privé.
          </p>
          <ul className="text-sm space-y-2 pl-4 list-disc marker:text-gold">
            <li>Vérifier la configuration du serveur et son nom DDNS.</li>
            <li>Tester la réception SMTP entrante sur TCP 25.</li>
            <li>Ajouter vos domaines et contrôler leurs enregistrements DNS.</li>
            <li>Valider la réception locale puis la connexion au relais d’envoi.</li>
          </ul>
          <Button onClick={() => setStep(1)} className="bg-gold text-background hover:opacity-90">
            Commencer
          </Button>
        </div>
      )}

      {step === 1 && (
        <div className="noir-panel rounded-3xl p-8 space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-display text-2xl text-gold">Votre serveur</h2>
              <p className="text-sm text-muted-foreground">
                Le nom DDNS utilisé comme cible MX doit pointer vers l’adresse publique qui redirige
                le port TCP 25 vers ce serveur.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                refetchEnv();
                refetchHealth();
              }}
              disabled={envLoading}
            >
              {envLoading ? "Vérification…" : "Revérifier"}
            </Button>
          </div>

          <div className="rounded-lg bg-card p-4 border border-border flex items-center justify-between gap-4">
            <div>
              <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
                Adresse IPv4 publique attendue — facultatif
              </div>
              <div className="font-mono text-2xl text-gold mt-1">
                {serverIp || "vérification par DDNS ci-dessous"}
              </div>
            </div>
            {serverIp && <CopyBtn value={serverIp} />}
          </div>

          <div className="rounded-lg bg-card p-4 border border-border flex items-center justify-between gap-4">
            <div>
              <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
                Cible MX / nom DDNS configuré
              </div>
              <div className="font-mono text-lg text-gold mt-1">
                {mailHostname || "non configuré"}
              </div>
            </div>
            {mailHostname && <CopyBtn value={mailHostname} />}
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            {[
              ["URL des services internes", env?.env.SUPABASE_URL],
              ["Clé publique des services", env?.env.SUPABASE_PUBLISHABLE_KEY],
              ["Clé privée des services", env?.env.SUPABASE_SERVICE_ROLE_KEY],
              ["Secret de réception", env?.env.INBOUND_WEBHOOK_SECRET],
              ["Adresse Jellyfin", env?.env.JELLYFIN_URL],
              ["Clé API Jellyfin", env?.env.JELLYFIN_API_KEY],
              ["Relais SMTP sortant", env?.env.OUTBOUND_SMTP_ENABLED],
              [
                "Identifiants du relais",
                env?.env.OUTBOUND_SMTP_USERNAME && env?.env.OUTBOUND_SMTP_PASSWORD,
              ],
            ].map(([label, ok]) => (
              <div
                key={label as string}
                className="rounded-lg bg-card p-3 border border-border flex items-center justify-between"
              >
                <span className="text-sm">{label as string}</span>
                <Pill
                  state={ok === undefined ? "idle" : ok ? "ok" : "fail"}
                  label={ok === undefined ? "…" : ok ? "Configuré" : "Manquant"}
                />
              </div>
            ))}
          </div>

          <div className="rounded-lg bg-card p-4 border border-border">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm">État des services</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => refetchHealth()}
                disabled={healthLoading}
              >
                {healthLoading ? "Vérification…" : "Tester les services"}
              </Button>
            </div>
            {health ? (
              <div className="grid grid-cols-4 gap-2 text-center text-xs">
                {[
                  ["Utilisateurs", health.users],
                  ["Domaines", health.domains],
                  ["Adresses", health.mailboxes],
                  ["Messages", health.messages],
                ].map(([l, v]) => (
                  <div key={l as string} className="rounded border border-border p-2">
                    <div className="text-muted-foreground">{l as string}</div>
                    <div className="text-gold font-display text-xl">{v as number}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">Pas encore vérifié.</div>
            )}
          </div>

          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setStep(0)}>
              Retour
            </Button>
            <Button onClick={() => setStep(2)} className="bg-gold text-background">
              Suivant : ports
            </Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="noir-panel rounded-3xl p-8 space-y-5">
          <h2 className="font-display text-2xl text-gold">Ports de messagerie</h2>
          <p className="text-sm text-muted-foreground">
            La réception depuis Internet utilise le port <strong>TCP 25</strong>. L’envoi établit
            une connexion sortante chiffrée vers le relais sur le port 587 ou 465 : ces deux ports
            ne doivent jamais être redirigés depuis le routeur.
          </p>

          <ol className="text-sm space-y-2 pl-5 list-decimal marker:text-gold">
            <li>
              Ouvrez l’administration de votre routeur (généralement{" "}
              <code className="text-gold">http://192.168.1.1</code>) →{" "}
              <em>Redirection de ports / NAT / Serveur virtuel</em>).
            </li>
            <li>
              Redirigez le port public <strong>TCP 25</strong> vers l’adresse privée de ce serveur,
              port 25.
            </li>
            <li>
              Ne redirigez <strong>pas</strong> les ports de l’application ou de l’API : les
              comptes, les conversations et l’administration restent ainsi privés.
            </li>
            <li>
              Si un pare-feu est actif, autorisez explicitement TCP 25 avec les règles adaptées à
              votre système.
            </li>
            <li>
              Attribuez une adresse privée fixe au serveur, ou créez une réservation DHCP, afin que
              la redirection survive aux redémarrages.
            </li>
          </ol>
          <div className="text-xs text-muted-foreground">
            Le DDNS ne contourne ni le CGNAT ni un blocage du port 25 par votre opérateur. Ce test
            confirme uniquement le fonctionnement local du service SMTP. Vérifiez ensuite le port
            public depuis un réseau mobile, un VPS ou un autre réseau réellement extérieur.
          </div>

          <div className="flex gap-2 items-center">
            <code className="min-w-0 flex-1 truncate rounded border border-border bg-card px-3 py-2 text-sm text-gold">
              {mailHostname || "MAIL_HOSTNAME n’est pas configuré"}
            </code>
            <Button
              onClick={testAllPorts}
              disabled={portResults[25]?.loading}
              className="bg-gold text-background whitespace-nowrap"
            >
              Tester la réception locale
            </Button>
          </div>

          <div className="rounded-lg border border-border divide-y divide-border">
            {PORTS.map((p) => {
              const r = portResults[p.port];
              const state: PillState = !r ? "idle" : r.loading ? "run" : r.open ? "ok" : "fail";
              return (
                <div key={p.port} className="p-3 flex flex-wrap items-center gap-3">
                  <div className="flex-1 min-w-[220px]">
                    <div className="text-sm font-medium">{p.label}</div>
                    <div className="text-xs text-muted-foreground">{p.why}</div>
                    {r && !r.loading && (
                      <div className="text-[11px] mt-1 font-mono text-muted-foreground truncate">
                        {r.open ? (r.banner ? r.banner : "connexion acceptée") : r.error}
                      </div>
                    )}
                  </div>
                  <Pill
                    state={state}
                    label={
                      state === "ok"
                        ? "Service prêt"
                        : state === "fail"
                          ? "Échec du test local"
                          : undefined
                    }
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={r?.loading}
                    onClick={() => testPort(p.port, p.banner)}
                  >
                    Tester
                  </Button>
                </div>
              );
            })}
          </div>

          <div className="rounded-2xl border border-border bg-card/60 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold">Envoi vers Internet</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Connexion sortante chiffrée vers le relais SMTP configuré. Aucun port 465 ou 587
                  ne doit être ouvert sur le routeur.
                </div>
              </div>
              <Pill
                state={
                  outboundCheck.isPending
                    ? "run"
                    : outboundCheck.isSuccess && outboundCheck.data.enabled
                      ? "ok"
                      : outboundCheck.isError
                        ? "fail"
                        : "idle"
                }
                label={
                  outboundCheck.isSuccess
                    ? outboundCheck.data.enabled
                      ? "Authentifié"
                      : "Désactivé"
                    : undefined
                }
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => outboundCheck.mutate()}
              disabled={outboundCheck.isPending || !env?.env.OUTBOUND_SMTP_ENABLED}
            >
              {outboundCheck.isPending ? "Connexion…" : "Tester le relais authentifié"}
            </Button>
            {!env?.env.OUTBOUND_SMTP_ENABLED && (
              <p className="text-xs text-amber-200/80">
                Relancez l’installateur et activez l’envoi sortant lorsque vous aurez les
                identifiants fournis par votre relais SMTP.
              </p>
            )}
          </div>

          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setStep(1)}>
              Retour
            </Button>
            <Button onClick={() => setStep(3)} className="bg-gold text-background">
              Suivant : domaines
            </Button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="noir-panel rounded-3xl p-8 space-y-4">
          <h2 className="font-display text-2xl text-gold">Ajouter vos domaines</h2>
          <p className="text-sm text-muted-foreground">
            Ajoutez les domaines que vous possédez. Ils seront proposés lors de la création d’une
            adresse.
          </p>
          <div className="flex gap-2">
            <Input
              placeholder="example.com"
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addDomain.mutate()}
            />
            <Button onClick={() => addDomain.mutate()} className="bg-gold text-background">
              Ajouter
            </Button>
          </div>
          <div className="rounded-lg border border-border divide-y divide-border">
            {(domains ?? []).map((d) => (
              <div key={d.id} className="p-3 flex items-center justify-between">
                <span className="font-mono text-sm">{d.name}</span>
                <span className="text-xs text-muted-foreground">ajouté</span>
              </div>
            ))}
            {(!domains || domains.length === 0) && (
              <div className="p-8 text-center text-sm text-muted-foreground">
                Aucun domaine — ajoutez-en au moins un pour continuer.
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setStep(2)}>
              Retour
            </Button>
            <Button
              onClick={() => setStep(4)}
              disabled={!domains?.length}
              className="bg-gold text-background"
            >
              Suivant : DNS
            </Button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="noir-panel rounded-3xl p-8 space-y-4">
          <h2 className="font-display text-2xl text-gold">Enregistrements DNS</h2>
          <p className="text-sm text-muted-foreground">
            Pour chaque domaine, faites pointer l’enregistrement MX vers le nom DDNS configuré. La
            cible MX doit elle-même résoudre directement vers votre adresse publique.
          </p>
          <div className="flex gap-2 flex-wrap">
            {(domains ?? []).map((d) => (
              <button
                key={d.id}
                onClick={() => setSelectedDomain(d.name)}
                className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${selectedDomain === d.name ? "border-gold text-gold bg-gold/10" : "border-border text-muted-foreground hover:border-gold/50"}`}
              >
                {d.name}
              </button>
            ))}
          </div>
          {selectedDomain && (
            <RecordsTable
              domain={selectedDomain}
              mailHostname={mailHostname}
              outboundEnabled={Boolean(env?.env.OUTBOUND_SMTP_ENABLED)}
            />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setStep(3)}>
              Retour
            </Button>
            <Button onClick={() => setStep(5)} className="bg-gold text-background">
              Suivant : vérifier
            </Button>
          </div>
        </div>
      )}

      {step === 5 && (
        <div className="noir-panel rounded-3xl p-8 space-y-4">
          <h2 className="font-display text-2xl text-gold">Vérifier la propagation DNS</h2>
          <p className="text-sm text-muted-foreground">
            Les vérifications utilisent le résolveur DNS du serveur. La propagation peut prendre de
            quelques minutes à plusieurs heures.
          </p>
          {(domains ?? []).map((d) => (
            <div key={d.id} className="rounded-lg border border-border p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-gold">{d.name}</span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => checkAll(d.name)}
                  disabled={!mailHostname}
                >
                  Vérifier maintenant
                </Button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                {[
                  {
                    k: "MX",
                    label: `${d.name} MX`,
                    expectLabel: mailHostname || "MAIL_HOSTNAME manquant",
                  },
                  {
                    k: "MAIL_A",
                    label: `${mailHostname || "Cible MX"} A`,
                    expectLabel: serverIp
                      ? `Adresse IPv4 publique attendue : ${serverIp}`
                      : "Au moins une adresse IPv4",
                  },
                  {
                    k: "MAIL_AAAA",
                    label: `${mailHostname || "Cible MX"} AAAA`,
                    expectLabel: "Facultatif : supprimez-le si IPv6 n’atteint pas ce serveur",
                  },
                ].map((row) => {
                  const c = checks[`${d.name}:${row.k}`];
                  const optional = row.k === "MAIL_AAAA";
                  return (
                    <div key={row.k} className="rounded bg-card p-2 border border-border">
                      <div className="text-muted-foreground">{row.label}</div>
                      <div
                        className={`mt-1 font-medium ${c?.loading ? "text-muted-foreground" : c?.ok ? "text-emerald-400" : c ? "text-red-400" : "text-muted-foreground"}`}
                      >
                        {c?.loading
                          ? "Vérification…"
                          : c?.ok
                            ? "✓ Trouvé"
                            : c
                              ? optional
                                ? "Non publié (correct)"
                                : "✗ Introuvable"
                              : "—"}
                      </div>
                      <div
                        className="text-[10px] text-muted-foreground truncate mt-1"
                        title={row.expectLabel}
                      >
                        {row.expectLabel}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setStep(4)}>
              Retour
            </Button>
            <Button onClick={() => setStep(6)} className="bg-gold text-background">
              Suivant : tester
            </Button>
          </div>
        </div>
      )}

      {step === 6 && (
        <div className="noir-panel rounded-[1.75rem] p-8 space-y-5">
          <h2 className="font-display text-2xl text-gold">Tester la réception</h2>
          <p className="text-sm text-muted-foreground">
            Injectez un message dans une adresse réelle afin de confirmer son stockage et son
            classement. Créez d’abord cette adresse dans <em>Adresses</em>.
          </p>
          <div className="flex gap-2">
            <Input
              placeholder="vous@votredomaine.fr"
              value={testAddr}
              onChange={(e) => setTestAddr(e.target.value)}
            />
            <Button
              onClick={() => delivery.mutate()}
              disabled={!testAddr.trim() || delivery.isPending}
              className="bg-gold text-background whitespace-nowrap"
            >
              {delivery.isPending ? "Injection…" : "Créer un message de test"}
            </Button>
          </div>
          <div className="rounded-2xl bg-card p-4 border border-border text-sm space-y-2">
            <div className="font-medium">Testez ensuite depuis Internet :</div>
            <ol className="pl-5 list-decimal marker:text-gold text-muted-foreground space-y-1">
              <li>
                Envoyez un e-mail vers cette adresse depuis un compte extérieur : il doit apparaître
                dans la minute.
              </li>
              <li>Confirmez qu’il apparaît dans la bonne adresse JorgardeMail.</li>
              <li>
                Si rien n’arrive, consultez les journaux SMTP, testez TCP 25 depuis un autre réseau
                et vérifiez de nouveau la cible MX.
              </li>
            </ol>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setStep(5)}>
              Retour
            </Button>
            <Button onClick={() => setStep(7)} className="bg-gold text-background">
              Terminer
            </Button>
          </div>
        </div>
      )}

      {step === 7 && (
        <div className="noir-panel rounded-[1.75rem] p-8 space-y-4 text-center">
          <div className="text-5xl">✨</div>
          <h2 className="font-display text-3xl text-gold">Tout est prêt</h2>
          <p className="text-muted-foreground">
            Vos membres peuvent désormais créer des adresses permanentes ou temporaires sur{" "}
            {domains?.length ?? 0} domaine{domains?.length === 1 ? "" : "s"}. Les e-mails entrants
            utilisent TCP 25, l’envoi passe par le relais SMTP configuré et les conversations
            restent privées.
          </p>
          <div className="flex gap-2 justify-center">
            <Button variant="outline" onClick={() => setStep(0)}>
              Redémarrer l’assistant
            </Button>
            <Button
              className="bg-gold text-background"
              onClick={() => (window.location.href = "/all")}
            >
              Ouvrir la réception
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function RecordsTable({
  domain,
  mailHostname,
  outboundEnabled,
}: {
  domain: string;
  mailHostname: string;
  outboundEnabled: boolean;
}) {
  const mxTarget = mailHostname || "<nom DDNS de votre serveur mail>";
  const rows = [
    {
      host: "@",
      type: "MX",
      value: `10 ${mxTarget}.`,
      note: "Obligatoire : achemine les e-mails entrants vers ce serveur",
    },
    {
      host: "@",
      type: "TXT",
      value: outboundEnabled ? "Valeur SPF exacte fournie par le relais SMTP" : "v=spf1 -all",
      note: outboundEnabled
        ? "Obligatoire pour l'envoi : n'inventez pas le mécanisme include, copiez celui du fournisseur"
        : "Indique que ce domaine n’envoie aucun e-mail",
      copyable: !outboundEnabled,
    },
    {
      host: "sélecteur._domainkey",
      type: "TXT/CNAME",
      value: outboundEnabled
        ? "Enregistrement DKIM fourni par le relais SMTP"
        : "Non requis sans envoi",
      note: "Le nom, le type et la valeur dépendent du relais ; publiez-les sans modification",
      copyable: false,
    },
    {
      host: "_dmarc",
      type: "TXT",
      value: outboundEnabled
        ? `v=DMARC1; p=none; rua=mailto:postmaster@${domain}`
        : `v=DMARC1; p=reject; rua=mailto:postmaster@${domain}`,
      note: outboundEnabled
        ? "Commencez en observation, puis renforcez la politique après validation SPF et DKIM"
        : "Politique stricte adaptée à un domaine qui n'envoie rien",
      copyable: true,
    },
  ];
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <div className="grid grid-cols-[80px_60px_1fr_auto] gap-3 px-3 py-2 bg-card text-[11px] uppercase tracking-wider text-muted-foreground">
        <span>Nom</span>
        <span>Type</span>
        <span>Valeur</span>
        <span></span>
      </div>
      {rows.map((r, i) => (
        <div
          key={i}
          className="grid grid-cols-[80px_60px_1fr_auto] gap-3 px-3 py-3 items-center border-t border-border text-sm"
        >
          <span className="text-muted-foreground font-mono">{r.host}</span>
          <span className="text-gold font-mono">{r.type}</span>
          <div className="min-w-0">
            <div className="font-mono truncate" title={r.value}>
              {r.value}
            </div>
            <div className="text-xs text-muted-foreground">{r.note}</div>
          </div>
          {r.copyable !== false ? <CopyBtn value={r.value} /> : <span />}
        </div>
      ))}
    </div>
  );
}
