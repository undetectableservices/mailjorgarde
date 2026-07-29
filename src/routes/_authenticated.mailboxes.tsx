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
import { toast } from "sonner";
import { Trash2 } from "lucide-react";

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
  { label: "1 hour", minutes: 60 },
  { label: "1 day", minutes: 60 * 24 },
  { label: "7 days", minutes: 60 * 24 * 7 },
  { label: "30 days", minutes: 60 * 24 * 30 },
];

export const Route = createFileRoute("/_authenticated/mailboxes")({
  head: () => ({
    meta: [
      { title: "Mailboxes — JorgardeMail" },
      {
        name: "description",
        content: "Create permanent or temporary addresses across your domains.",
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
          .order("created_at", { ascending: false })
      ).data ?? [],
  });

  const domainExpiry = (expires_at: string | null | undefined) => {
    if (!expires_at) return null;
    const days = Math.ceil((new Date(expires_at).getTime() - Date.now()) / 86400000);
    if (days < 0) return { text: `Domain expired ${-days}d ago`, tone: "text-red-400" };
    if (days <= 30) return { text: `Domain expires in ${days}d`, tone: "text-amber-400" };
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
        throw new Error("Invalid address (1-64 characters: a-z, 0-9, . _ -)");
      }
      const head = lp.split(/[._-]/)[0];
      if (RESERVED.has(lp) || RESERVED.has(head)) throw new Error("That name is reserved");
      if (!domainId) throw new Error("Pick a domain");
      if (used >= limit) throw new Error(`Quota reached (${limit} mailboxes)`);
      const { error } = await supabase.rpc("create_mailbox", {
        p_local_part: lp,
        p_domain_id: domainId,
        p_is_temp: isTemp,
        p_ttl_minutes: isTemp ? ttl : null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Mailbox created");
      setLocal("");
      qc.invalidateQueries({ queryKey: ["mailboxes"] });
      refetch();
    },
    onError: (error) => toast.error(errorMessage(error, "Could not create the mailbox")),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("delete_mailbox", { p_mailbox_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Deleted");
      qc.invalidateQueries({ queryKey: ["mailboxes"] });
      refetch();
    },
    onError: (error) => toast.error(errorMessage(error, "Could not delete the mailbox")),
  });

  const extend = useMutation({
    mutationFn: async ({ id, minutes }: { id: string; minutes: number | null }) => {
      const { error } = await supabase.rpc("set_mailbox_lifetime", {
        p_mailbox_id: id,
        p_ttl_minutes: minutes,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Updated");
      refetch();
    },
    onError: (error) => toast.error(errorMessage(error, "Could not update the mailbox")),
  });

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="font-display text-4xl text-gold">Mailboxes</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Permanent or temporary. Up to {limit} addresses per account.
        </p>
      </div>

      <div className="noir-panel rounded-xl p-5 mb-6">
        <div className="flex items-center justify-between mb-2 text-sm">
          <span>
            {used} / {limit} used
          </span>
          <span className="text-muted-foreground">{Math.max(0, limit - used)} remaining</span>
        </div>
        <Progress
          value={limit > 0 ? Math.min(100, (used / limit) * 100) : used > 0 ? 100 : 0}
          className="h-2"
        />
      </div>

      <div className="noir-panel rounded-xl p-6 mb-8 space-y-4">
        <h2 className="font-display text-xl">Create new address</h2>
        {!domains || domains.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No domains configured yet. An admin needs to add one first.
          </div>
        ) : (
          <>
            <div className="grid md:grid-cols-[1fr_auto_1fr] gap-2 items-center">
              <Input
                placeholder="local-part"
                value={local}
                onChange={(e) => setLocal(e.target.value)}
              />
              <span className="text-muted-foreground">@</span>
              <Select value={domainId} onValueChange={setDomainId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose domain" />
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
                <Switch checked={isTemp} onCheckedChange={setIsTemp} /> Temporary
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
                className="bg-gold text-background hover:opacity-90 ml-auto"
              >
                Create
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Reserved names (admin, server, owner, root, postmaster, etc.) can't be used.
            </p>
          </>
        )}
      </div>

      <div className="noir-panel rounded-xl divide-y divide-border overflow-hidden">
        {(mailboxes ?? []).map((mb) => (
          <div key={mb.id} className="p-4 flex items-center gap-4">
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
              <div className="text-xs text-muted-foreground">
                {mb.is_temp
                  ? `Temporary — expires ${mb.expires_at ? new Date(mb.expires_at).toLocaleString() : "?"}`
                  : "Permanent"}
              </div>
            </div>
            {mb.is_temp && (
              <Select
                onValueChange={(v) =>
                  extend.mutate({ id: mb.id, minutes: v === "perm" ? null : Number(v) })
                }
              >
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="Extend" />
                </SelectTrigger>
                <SelectContent>
                  {TTL_PRESETS.map((p) => (
                    <SelectItem key={p.label} value={String(p.minutes)}>
                      +{p.label}
                    </SelectItem>
                  ))}
                  <SelectItem value="perm">Make permanent</SelectItem>
                </SelectContent>
              </Select>
            )}
            {!REQUIRED_DOMAIN_ALIASES.has(mb.local_part) && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Delete ${mb.local_part}@${mb.domain?.name}`}
                disabled={del.isPending}
                onClick={() => {
                  const address = `${mb.local_part}@${mb.domain?.name}`;
                  if (
                    window.confirm(
                      `Delete ${address} and every message stored in it? This cannot be undone.`,
                    )
                  ) {
                    del.mutate(mb.id);
                  }
                }}
              >
                <Trash2 size={16} />
              </Button>
            )}
          </div>
        ))}
        {(!mailboxes || mailboxes.length === 0) && (
          <div className="p-12 text-center text-muted-foreground">No mailboxes yet.</div>
        )}
      </div>
    </div>
  );
}
