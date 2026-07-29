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
  checkPort,
  checkServerEnv,
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
          toast.error(error instanceof Error ? error.message : "Copy failed");
        }
      }}
      className="text-xs px-2 py-1 rounded border border-border hover:border-gold hover:text-gold transition-colors"
    >
      {ok ? "Copied" : "Copy"}
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
      ? "Pass"
      : state === "fail"
        ? "Fail"
        : state === "run"
          ? "Testing…"
          : "Not tested");
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded-full border whitespace-nowrap ${tone}`}>
      {txt}
    </span>
  );
}

const PORTS = [
  {
    port: 25,
    label: "Internet SMTP receiver (TCP 25)",
    why: "Other mail servers deliver inbound mail here. This is the only public mail port this receive-only service needs.",
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
  const runPort = useServerFn(checkPort);
  const runDns = useServerFn(checkDns);
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
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(n))
        throw new Error("Enter a valid domain like example.com");
      const { error } = await supabase.from("domains").insert({ name: n });
      if (error) throw error;
    },
    onSuccess: () => {
      setNewDomain("");
      refetchDomains();
      toast.success("Domain added");
    },
    onError: (error) => toast.error(getErrorMessage(error, "Failed to add domain")),
  });

  const testPort = async (port: number, banner: boolean) => {
    if (!mailHostname) return toast.error("Configure MAIL_HOSTNAME first");
    setPortResults((r) => ({ ...r, [port]: { loading: true } }));
    try {
      const res = await runPort({ data: { banner } });
      setPortResults((r) => ({ ...r, [port]: res }));
    } catch (error: unknown) {
      setPortResults((r) => ({
        ...r,
        [port]: { loading: false, open: false, error: getErrorMessage(error, "test failed") },
      }));
    }
  };

  const testAllPorts = async () => {
    for (const p of PORTS) await testPort(p.port, p.banner);
  };

  const delivery = useMutation({
    mutationFn: async () => runDelivery({ data: { to: testAddr.trim() } }),
    onSuccess: (r) => {
      toast.success(`Test message delivered to ${r.to} — check the inbox.`);
      refetchHealth();
    },
    onError: (error) => toast.error(getErrorMessage(error, "Delivery test failed")),
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
      runCheck(`${d}:MAIL_A`, mailHostname, "A", (records) => records.length > 0),
      runCheck(`${d}:MAIL_AAAA`, mailHostname, "AAAA", (records) => records.length > 0),
    ]);
  };

  const steps = [
    "Welcome",
    "Server",
    "Ports",
    "Domains",
    "DNS records",
    "Verify DNS",
    "Test mail",
    "Done",
  ];

  return (
    <div className="space-y-6">
      {/* Progress rail */}
      <div className="noir-panel rounded-xl p-4">
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
        <div className="noir-panel rounded-xl p-8 space-y-4">
          <h2 className="font-display text-3xl text-gold">Welcome to JorgardeMail</h2>
          <p className="text-muted-foreground">
            This wizard takes you from a fresh install to reliably receiving internet mail while
            keeping the web app on your LAN.
          </p>
          <ul className="text-sm space-y-2 pl-4 list-disc marker:text-gold">
            <li>Confirm the server config and its public IP.</li>
            <li>Forward and test inbound SMTP on TCP 25.</li>
            <li>Add your domains and their DNS records, verified live.</li>
            <li>Test database delivery, then send a real message from an outside provider.</li>
          </ul>
          <Button onClick={() => setStep(1)} className="bg-gold text-background hover:opacity-90">
            Start setup
          </Button>
        </div>
      )}

      {step === 1 && (
        <div className="noir-panel rounded-xl p-8 space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-display text-2xl text-gold">Your server</h2>
              <p className="text-sm text-muted-foreground">
                Your DDNS mail hostname must resolve to the public address that forwards TCP 25
                here.
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
              {envLoading ? "Testing…" : "Re-test"}
            </Button>
          </div>

          <div className="rounded-lg bg-card p-4 border border-border flex items-center justify-between gap-4">
            <div>
              <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
                Optional expected public IP
              </div>
              <div className="font-mono text-2xl text-gold mt-1">
                {serverIp || "verify through DDNS below"}
              </div>
            </div>
            {serverIp && <CopyBtn value={serverIp} />}
          </div>

          <div className="rounded-lg bg-card p-4 border border-border flex items-center justify-between gap-4">
            <div>
              <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
                Configured MX target / DDNS hostname
              </div>
              <div className="font-mono text-lg text-gold mt-1">
                {mailHostname || "not configured"}
              </div>
            </div>
            {mailHostname && <CopyBtn value={mailHostname} />}
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            {[
              ["Backend URL", env?.env.SUPABASE_URL],
              ["Backend public key", env?.env.SUPABASE_PUBLISHABLE_KEY],
              ["Backend service key", env?.env.SUPABASE_SERVICE_ROLE_KEY],
              ["Inbound webhook secret", env?.env.INBOUND_WEBHOOK_SECRET],
            ].map(([label, ok]) => (
              <div
                key={label as string}
                className="rounded-lg bg-card p-3 border border-border flex items-center justify-between"
              >
                <span className="text-sm">{label as string}</span>
                <Pill
                  state={ok === undefined ? "idle" : ok ? "ok" : "fail"}
                  label={ok === undefined ? "…" : ok ? "Configured" : "Missing"}
                />
              </div>
            ))}
          </div>

          <div className="rounded-lg bg-card p-4 border border-border">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm">Backend connectivity</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => refetchHealth()}
                disabled={healthLoading}
              >
                {healthLoading ? "Testing…" : "Test backend"}
              </Button>
            </div>
            {health ? (
              <div className="grid grid-cols-4 gap-2 text-center text-xs">
                {[
                  ["Users", health.users],
                  ["Domains", health.domains],
                  ["Mailboxes", health.mailboxes],
                  ["Messages", health.messages],
                ].map(([l, v]) => (
                  <div key={l as string} className="rounded border border-border p-2">
                    <div className="text-muted-foreground">{l as string}</div>
                    <div className="text-gold font-display text-xl">{v as number}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">Not tested yet.</div>
            )}
          </div>

          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setStep(0)}>
              Back
            </Button>
            <Button onClick={() => setStep(2)} className="bg-gold text-background">
              Next: ports
            </Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="noir-panel rounded-xl p-8 space-y-5">
          <h2 className="font-display text-2xl text-gold">Expose only inbound SMTP</h2>
          <p className="text-sm text-muted-foreground">
            Internet mail delivery uses <strong>TCP 25</strong>. The web UI and API stay on your
            LAN; ports 465 and 587 are not used because this build does not provide outbound
            submission.
          </p>

          <ol className="text-sm space-y-2 pl-5 list-decimal marker:text-gold">
            <li>
              Open your router admin page (usually{" "}
              <code className="text-gold">http://192.168.1.1</code>) →{" "}
              <em>Port forwarding / NAT / Virtual server</em>.
            </li>
            <li>
              Forward public <strong>TCP 25</strong> to this server's LAN IP, port 25.
            </li>
            <li>
              Do <strong>not</strong> forward the web or API ports — that keeps accounts, DMs, and
              the admin panel private.
            </li>
            <li>
              If the server has a firewall, allow TCP 25 explicitly using the firewall rules
              appropriate for your host.
            </li>
            <li>
              Give your server a static LAN IP or a DHCP reservation so the forward doesn't break on
              reboot.
            </li>
          </ol>
          <div className="text-xs text-muted-foreground">
            DDNS cannot bypass CGNAT or an ISP block on port 25. A test from this server can also be
            fooled by NAT loopback; the final proof is delivery from an outside mail provider.
          </div>

          <div className="flex gap-2 items-center">
            <code className="min-w-0 flex-1 truncate rounded border border-border bg-card px-3 py-2 text-sm text-gold">
              {mailHostname || "MAIL_HOSTNAME is not configured"}
            </code>
            <Button onClick={testAllPorts} className="bg-gold text-background whitespace-nowrap">
              Test TCP 25
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
                        {r.open ? (r.banner ? r.banner : "connection accepted") : r.error}
                      </div>
                    )}
                  </div>
                  <Pill
                    state={state}
                    label={
                      state === "ok" ? "Reachable" : state === "fail" ? "Unreachable" : undefined
                    }
                  />
                  <Button size="sm" variant="outline" onClick={() => testPort(p.port, p.banner)}>
                    Test
                  </Button>
                </div>
              );
            })}
          </div>

          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button onClick={() => setStep(3)} className="bg-gold text-background">
              Next: add domains
            </Button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="noir-panel rounded-xl p-8 space-y-4">
          <h2 className="font-display text-2xl text-gold">Add your domains</h2>
          <p className="text-sm text-muted-foreground">
            Add as many domains as you own. Users will pick from these when creating a mailbox.
          </p>
          <div className="flex gap-2">
            <Input
              placeholder="example.com"
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addDomain.mutate()}
            />
            <Button onClick={() => addDomain.mutate()} className="bg-gold text-background">
              Add
            </Button>
          </div>
          <div className="rounded-lg border border-border divide-y divide-border">
            {(domains ?? []).map((d) => (
              <div key={d.id} className="p-3 flex items-center justify-between">
                <span className="font-mono text-sm">{d.name}</span>
                <span className="text-xs text-muted-foreground">added</span>
              </div>
            ))}
            {(!domains || domains.length === 0) && (
              <div className="p-8 text-center text-sm text-muted-foreground">
                No domains yet — add at least one to continue.
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setStep(2)}>
              Back
            </Button>
            <Button
              onClick={() => setStep(4)}
              disabled={!domains?.length}
              className="bg-gold text-background"
            >
              Next: DNS records
            </Button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="noir-panel rounded-xl p-8 space-y-4">
          <h2 className="font-display text-2xl text-gold">DNS records</h2>
          <p className="text-sm text-muted-foreground">
            For each receiving domain, point MX at the configured DDNS hostname. The MX target
            itself must resolve directly to your public address.
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
          {selectedDomain && <RecordsTable domain={selectedDomain} mailHostname={mailHostname} />}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setStep(3)}>
              Back
            </Button>
            <Button onClick={() => setStep(5)} className="bg-gold text-background">
              Next: verify
            </Button>
          </div>
        </div>
      )}

      {step === 5 && (
        <div className="noir-panel rounded-xl p-8 space-y-4">
          <h2 className="font-display text-2xl text-gold">Verify DNS propagation</h2>
          <p className="text-sm text-muted-foreground">
            Checks use the DNS resolver configured on this server. Propagation can take a few
            minutes to a few hours.
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
                  Check now
                </Button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                {[
                  {
                    k: "MX",
                    label: `${d.name} MX`,
                    expectLabel: mailHostname || "MAIL_HOSTNAME missing",
                  },
                  {
                    k: "MAIL_A",
                    label: `${mailHostname || "MX host"} A`,
                    expectLabel: "At least one IPv4 address",
                  },
                  {
                    k: "MAIL_AAAA",
                    label: `${mailHostname || "MX host"} AAAA`,
                    expectLabel: "Optional; remove it unless IPv6 reaches this server",
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
                          ? "Checking…"
                          : c?.ok
                            ? "✓ Found"
                            : c
                              ? optional
                                ? "Not published (OK)"
                                : "✗ Not found"
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
              Back
            </Button>
            <Button onClick={() => setStep(6)} className="bg-gold text-background">
              Next: test mail
            </Button>
          </div>
        </div>
      )}

      {step === 6 && (
        <div className="noir-panel rounded-xl p-8 space-y-5">
          <h2 className="font-display text-2xl text-gold">Test mail delivery</h2>
          <p className="text-sm text-muted-foreground">
            Drop a message straight into a real mailbox to confirm storage and inbox routing. Create
            the address first under <em>Mailboxes</em>.
          </p>
          <div className="flex gap-2">
            <Input
              placeholder="you@yourdomain.com"
              value={testAddr}
              onChange={(e) => setTestAddr(e.target.value)}
            />
            <Button
              onClick={() => delivery.mutate()}
              disabled={!testAddr.trim() || delivery.isPending}
              className="bg-gold text-background whitespace-nowrap"
            >
              {delivery.isPending ? "Injecting…" : "Inject storage test"}
            </Button>
          </div>
          <div className="rounded-lg bg-card p-4 border border-border text-sm space-y-2">
            <div className="font-medium">Then test the real world:</div>
            <ol className="pl-5 list-decimal marker:text-gold text-muted-foreground space-y-1">
              <li>
                From an outside account (Gmail etc.), email that address — it should land in the
                inbox within a minute.
              </li>
              <li>Confirm it appears in the correct JorgardeMail mailbox.</li>
              <li>
                If nothing arrives, inspect SMTP logs, test TCP 25 from outside your network, and
                re-check the MX target.
              </li>
            </ol>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setStep(5)}>
              Back
            </Button>
            <Button onClick={() => setStep(7)} className="bg-gold text-background">
              Finish
            </Button>
          </div>
        </div>
      )}

      {step === 7 && (
        <div className="noir-panel rounded-xl p-8 space-y-4 text-center">
          <div className="text-5xl">✨</div>
          <h2 className="font-display text-3xl text-gold">You're live</h2>
          <p className="text-muted-foreground">
            Your users can now create permanent or temporary addresses across {domains?.length ?? 0}{" "}
            domain{domains?.length === 1 ? "" : "s"}. Internet mail is received on port 25 and
            internal DMs stay inside this server.
          </p>
          <div className="flex gap-2 justify-center">
            <Button variant="outline" onClick={() => setStep(0)}>
              Restart wizard
            </Button>
            <Button
              className="bg-gold text-background"
              onClick={() => (window.location.href = "/all")}
            >
              Go to inbox
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function RecordsTable({ domain, mailHostname }: { domain: string; mailHostname: string }) {
  const mxTarget = mailHostname || "<your DDNS mail hostname>";
  const rows = [
    {
      host: "@",
      type: "MX",
      value: `10 ${mxTarget}.`,
      note: "Required: route inbound mail to this server",
    },
    {
      host: "@",
      type: "TXT",
      value: "v=spf1 -all",
      note: "Optional only if this domain never sends email from any provider",
    },
    {
      host: "_dmarc",
      type: "TXT",
      value: `v=DMARC1; p=reject; rua=mailto:postmaster@${domain}`,
      note: "Optional if the domain never sends; create the postmaster mailbox first",
    },
  ];
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <div className="grid grid-cols-[80px_60px_1fr_auto] gap-3 px-3 py-2 bg-card text-[11px] uppercase tracking-wider text-muted-foreground">
        <span>Host</span>
        <span>Type</span>
        <span>Value</span>
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
          <CopyBtn value={r.value} />
        </div>
      ))}
    </div>
  );
}
