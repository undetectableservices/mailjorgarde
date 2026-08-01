import { createHash, randomBytes } from "node:crypto";

import { supabaseAdmin } from "@/integrations/supabase/client.server";

const API_KEY_RE = /^jm_[A-Za-z0-9_-]{43}$/;
const windows = new Map<string, { startedAt: number; count: number }>();

export function hashApiSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function newApiSecret(): string {
  return `jm_${randomBytes(32).toString("base64url")}`;
}

function consume(key: string, maximum: number, durationMs: number): boolean {
  const now = Date.now();
  const current = windows.get(key);
  if (!current || now - current.startedAt >= durationMs) {
    windows.set(key, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= maximum;
}

export async function authenticateDeveloperApi(
  request: Request,
  action: "create" | "read",
): Promise<{ userId: string; keyId: string } | null> {
  const authorization = request.headers.get("authorization") || "";
  const secret = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!API_KEY_RE.test(secret)) return null;

  const hash = hashApiSecret(secret);
  const { data: key, error } = await supabaseAdmin
    .from("api_keys")
    .select("id, user_id")
    .eq("key_hash", hash)
    .maybeSingle();
  if (error || !key) return null;

  const [{ data: profile }, { data: adminRole }] = await Promise.all([
    supabaseAdmin
      .from("profiles")
      .select("api_access, account_kind, suspended_until")
      .eq("user_id", key.user_id)
      .maybeSingle(),
    supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", key.user_id)
      .eq("role", "admin")
      .maybeSingle(),
  ]);
  if (
    (!profile?.api_access && !adminRole) ||
    profile?.account_kind !== "member" ||
    (!!profile.suspended_until && Date.parse(profile.suspended_until) > Date.now())
  )
    return null;

  const allowed =
    action === "create"
      ? consume(`${hash}:create`, 20, 60 * 60_000)
      : consume(`${hash}:read`, 180, 60_000);
  if (!allowed) throw new Error("rate_limited");

  await supabaseAdmin
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", key.id);
  return { userId: key.user_id, keyId: key.id };
}

export async function createRandomApiMailbox(userId: string, ttlMinutes: number) {
  const [{ data: profile, error: profileError }, { data: adminRole }] = await Promise.all([
    supabaseAdmin
      .from("profiles")
      .select("mailbox_limit, api_access")
      .eq("user_id", userId)
      .maybeSingle(),
    supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "admin")
      .maybeSingle(),
  ]);
  if (profileError || !profile || (!profile.api_access && !adminRole)) {
    throw new Error("forbidden");
  }

  const { count } = await supabaseAdmin
    .from("mailboxes")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  if ((count ?? 0) >= profile.mailbox_limit) throw new Error("mailbox_limit_reached");

  const now = Date.now();
  const { data: domains, error: domainError } = await supabaseAdmin
    .from("domains")
    .select("id, name, expires_at")
    .order("name");
  if (domainError) throw domainError;
  const available = (domains ?? []).filter(
    (domain) => !domain.expires_at || Date.parse(domain.expires_at) > now,
  );
  if (available.length === 0) throw new Error("no_domain_available");
  const domain = available[randomBytes(2).readUInt16BE(0) % available.length];
  const expiresAt = new Date(now + ttlMinutes * 60_000).toISOString();

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const localPart = `api-${randomBytes(9).toString("hex")}`;
    const { data: mailbox, error } = await supabaseAdmin
      .from("mailboxes")
      .insert({
        user_id: userId,
        local_part: localPart,
        domain_id: domain.id,
        is_temp: true,
        expires_at: expiresAt,
      })
      .select("id, expires_at")
      .single();
    if (error?.code === "23505") continue;
    if (error || !mailbox) throw error ?? new Error("mailbox_creation_failed");
    const { error: linkError } = await supabaseAdmin.from("api_mailboxes").insert({
      mailbox_id: mailbox.id,
      user_id: userId,
    });
    if (linkError) {
      await supabaseAdmin.from("mailboxes").delete().eq("id", mailbox.id);
      throw linkError;
    }
    return {
      id: mailbox.id,
      address: `${localPart}@${domain.name}`,
      expires_at: mailbox.expires_at,
    };
  }
  throw new Error("mailbox_creation_failed");
}
