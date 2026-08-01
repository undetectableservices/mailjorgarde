import { createHash, randomBytes } from "node:crypto";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";

const API_KEY_RE = /^jm_[A-Za-z0-9_-]{43}$/;
const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export type DeveloperApiIdentity = {
  userId: string;
  keyId: string;
  keyName: string;
  keyPrefix: string;
};

export function hashApiSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function newApiSecret(): string {
  return `jm_${randomBytes(32).toString("base64url")}`;
}

export async function authenticateDeveloperApi(
  request: Request,
): Promise<DeveloperApiIdentity | null> {
  const authorization = request.headers.get("authorization") || "";
  const secret = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!API_KEY_RE.test(secret)) return null;

  const hash = hashApiSecret(secret);
  const { data: key, error } = await supabaseAdmin
    .from("api_keys")
    .select("id, user_id, name, key_prefix")
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
  ) {
    return null;
  }

  await supabaseAdmin
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", key.id);
  return {
    userId: key.user_id,
    keyId: key.id,
    keyName: key.name,
    keyPrefix: key.key_prefix,
  };
}

function clientIp(request?: Request): string | null {
  if (!request) return null;
  const value =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    null;
  return value ? value.slice(0, 64) : null;
}

export async function logApiActivity({
  userId,
  keyId = null,
  request,
  action,
  mailboxId = null,
  address = null,
  status = 200,
  metadata = {},
}: {
  userId: string;
  keyId?: string | null;
  request?: Request;
  action: string;
  mailboxId?: string | null;
  address?: string | null;
  status?: number;
  metadata?: Record<string, Json | undefined>;
}): Promise<void> {
  const cleanMetadata = Object.fromEntries(
    Object.entries(metadata).filter((entry): entry is [string, Json] => entry[1] !== undefined),
  );
  const { error } = await supabaseAdmin.from("api_activity_logs").insert({
    user_id: userId,
    api_key_id: keyId,
    action: action.slice(0, 64),
    mailbox_id: mailboxId,
    address,
    status,
    client_ip: clientIp(request),
    metadata: cleanMetadata,
  });
  if (error) console.error("[developer-api] activity log failed", error.message);
}

export async function listAvailableApiDomains(): Promise<Array<{ id: string; name: string }>> {
  const { data, error } = await supabaseAdmin
    .from("domains")
    .select("id, name")
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .order("name");
  if (error) throw error;
  return data ?? [];
}

function normalizeLocalPart(value: string): string {
  const localPart = value.trim().toLowerCase();
  if (!LOCAL_PART_RE.test(localPart) || localPart.includes("..")) {
    throw new Error("invalid_local_part");
  }
  return localPart;
}

export async function createApiMailbox(
  userId: string,
  options: { localPart?: string; domain?: string },
) {
  const custom = typeof options.localPart === "string";
  const attempts = custom ? 1 : 8;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const localPart = custom
      ? normalizeLocalPart(options.localPart ?? "")
      : `api-${randomBytes(9).toString("hex")}`;
    const { data, error } = await supabaseAdmin.rpc("create_api_mailbox", {
      p_user_id: userId,
      p_local_part: localPart,
      p_domain_name: options.domain?.trim() || null,
    });
    if (!error && data?.[0]) return data[0];
    if (error?.code === "23505" && !custom) continue;
    if (error?.code === "23505") throw new Error("address_already_exists");
    if (error?.code === "23514") throw new Error("api_mailbox_limit_reached");
    if (error?.code === "P0002") {
      throw new Error(options.domain ? "domain_unavailable" : "no_domain_available");
    }
    if (error?.code === "22023") throw new Error("invalid_local_part");
    if (error?.code === "42501") throw new Error("forbidden");
    throw error ?? new Error("mailbox_creation_failed");
  }
  throw new Error("mailbox_creation_failed");
}

export async function listOwnedApiMailboxes(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("api_mailboxes")
    .select("created_at, mailbox:mailboxes(id, local_part, domain:domains(name))")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? [])
    .filter((row) => row.mailbox)
    .map((row) => ({
      id: row.mailbox!.id,
      address: `${row.mailbox!.local_part}@${row.mailbox!.domain?.name ?? ""}`,
      created_at: row.created_at,
    }));
}

export async function findOwnedApiMailbox(userId: string, mailboxId: string) {
  const { data, error } = await supabaseAdmin
    .from("api_mailboxes")
    .select("created_at, mailbox:mailboxes(id, local_part, domain:domains(name))")
    .eq("user_id", userId)
    .eq("mailbox_id", mailboxId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.mailbox) return null;
  return {
    id: data.mailbox.id,
    address: `${data.mailbox.local_part}@${data.mailbox.domain?.name ?? ""}`,
    created_at: data.created_at,
  };
}

export async function deleteOwnedApiMailbox(userId: string, mailboxId: string) {
  const mailbox = await findOwnedApiMailbox(userId, mailboxId);
  if (!mailbox) return null;
  const { error } = await supabaseAdmin.from("mailboxes").delete().eq("id", mailboxId);
  if (error) throw error;
  return mailbox;
}

export async function listOwnedApiLogs(userId: string, limit = 200) {
  const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
  const { data, error } = await supabaseAdmin
    .from("api_activity_logs")
    .select(
      "id, action, mailbox_id, address, status, client_ip, metadata, created_at, api_key:api_keys(name, key_prefix)",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(safeLimit);
  if (error) throw error;
  return data ?? [];
}
