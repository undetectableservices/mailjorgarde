import { createHmac, timingSafeEqual } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const USERNAME_EMAIL_SUFFIX = "@users.jorgardemail.local";
const MAX_REQUEST_BYTES = 1_024;
const MAX_JELLYFIN_RESPONSE_BYTES = 1024 * 1024;
const MIN_RESPONSE_TIME_MS = 750;
const RATE_WINDOW_MS = 15 * 60_000;
const MAX_IP_ATTEMPTS = 8;
const MAX_USERNAME_ATTEMPTS = 6;
const MAX_RATE_BUCKETS = 10_000;

const registration = z
  .object({
    jellyfinUsername: z
      .string()
      .trim()
      .min(3)
      .max(24)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,22}[a-zA-Z0-9]$/),
    jellyfinPassword: z.string().min(1).max(128),
    mailPassword: z.string().min(12).max(128),
  })
  .strict();

type RateBucket = { startedAt: number; attempts: number };
type JellyfinUser = {
  Id?: unknown;
  Name?: unknown;
  Policy?: { IsDisabled?: unknown } | null;
};
type JellyfinAuthentication = {
  AccessToken?: unknown;
  User?: { Id?: unknown; Name?: unknown } | null;
};

const rateBuckets = new Map<string, RateBucket>();
const registrationLocks = new Set<string>();

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function genericFailure(status = 400): Response {
  return json({ ok: false, error: "Registration could not be completed." }, status);
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left.normalize("NFKC").toLowerCase(), "utf8");
  const b = Buffer.from(right.normalize("NFKC").toLowerCase(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function configuredJellyfin(): { baseUrl: string; apiKey: string } {
  const rawUrl = (process.env.JELLYFIN_URL || "").trim();
  const apiKey = (process.env.JELLYFIN_API_KEY || "").trim();
  if (!rawUrl || !/^[a-zA-Z0-9._~-]{16,256}$/.test(apiKey)) {
    throw new Error("Jellyfin registration is not configured");
  }

  const url = new URL(rawUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("JELLYFIN_URL must be a plain HTTP(S) server URL");
  }
  return { baseUrl: url.toString().replace(/\/$/, ""), apiKey };
}

async function readBoundedText(response: Response, maximum: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maximum) throw new Error("Jellyfin response is too large");
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel("response too large").catch(() => {});
        throw new Error("Jellyfin response is too large");
      }
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function jellyfinJson<T>(response: Response, maximum: number): Promise<T> {
  const raw = await readBoundedText(response, maximum);
  return JSON.parse(raw) as T;
}

function jellyfinClientAuthorization(token?: string, deviceId = "jorgardemail-server"): string {
  const fields = [
    'MediaBrowser Client="JorgardeMail"',
    'Device="JorgardeMail Server"',
    `DeviceId="${deviceId.replace(/[^a-zA-Z0-9_-]/g, "")}"`,
    'Version="1.0.0"',
  ];
  if (token) fields.push(`Token="${token.replace(/["\\]/g, "")}"`);
  return fields.join(", ");
}

async function fetchJellyfinUsers(baseUrl: string, apiKey: string): Promise<JellyfinUser[]> {
  const response = await fetch(`${baseUrl}/Users`, {
    headers: {
      accept: "application/json",
      authorization: jellyfinClientAuthorization(apiKey),
    },
    signal: AbortSignal.timeout(7_000),
  });
  if (!response.ok) throw new Error(`Jellyfin user lookup failed (HTTP ${response.status})`);
  const users = await jellyfinJson<unknown>(response, MAX_JELLYFIN_RESPONSE_BYTES);
  if (!Array.isArray(users)) throw new Error("Jellyfin returned an invalid user list");
  return users as JellyfinUser[];
}

async function authenticateJellyfinUser(
  baseUrl: string,
  username: string,
  password: string,
  deviceId: string,
): Promise<JellyfinAuthentication | null> {
  const response = await fetch(`${baseUrl}/Users/AuthenticateByName`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: jellyfinClientAuthorization(undefined, deviceId),
      "content-type": "application/json",
    },
    body: JSON.stringify({ Username: username, Pw: password }),
    signal: AbortSignal.timeout(7_000),
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`Jellyfin authentication failed (HTTP ${response.status})`);
  return jellyfinJson<JellyfinAuthentication>(response, 256 * 1024);
}

async function revokeJellyfinToken(baseUrl: string, token: string): Promise<void> {
  await fetch(`${baseUrl}/Sessions/Logout`, {
    method: "POST",
    headers: {
      authorization: jellyfinClientAuthorization(token),
    },
    signal: AbortSignal.timeout(3_000),
  }).catch(() => {});
}

function requestIdentity(request: Request): string {
  // Caddy overwrites X-Forwarded-For with the connecting WireGuard/LAN peer.
  // The raw value is HMACed immediately and is never retained in memory or logs.
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const address = forwarded || request.headers.get("x-real-ip") || "unknown-peer";
  const secret = process.env.INBOUND_WEBHOOK_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  return createHmac("sha256", secret).update(address).digest("hex");
}

function consumeRateLimit(key: string, maximum: number, now: number): boolean {
  const existing = rateBuckets.get(key);
  if (!existing || now - existing.startedAt >= RATE_WINDOW_MS) {
    rateBuckets.set(key, { startedAt: now, attempts: 1 });
    return true;
  }
  existing.attempts += 1;
  return existing.attempts <= maximum;
}

function pruneRateLimits(now: number): void {
  if (rateBuckets.size < MAX_RATE_BUCKETS) return;
  for (const [key, bucket] of rateBuckets) {
    if (now - bucket.startedAt >= RATE_WINDOW_MS) rateBuckets.delete(key);
  }
  while (rateBuckets.size >= MAX_RATE_BUCKETS) {
    const oldest = rateBuckets.keys().next().value;
    if (typeof oldest !== "string") break;
    rateBuckets.delete(oldest);
  }
}

async function readRegistration(request: Request): Promise<z.infer<typeof registration>> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > MAX_REQUEST_BYTES) throw new Error("request too large");
  if (!request.body) throw new Error("request body is required");

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel("request too large").catch(() => {});
        throw new Error("request too large");
      }
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return registration.parse(JSON.parse(raw));
}

function sameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const configuredSite = (process.env.SITE_URL || "").trim();
    if (configuredSite) return new URL(origin).origin === new URL(configuredSite).origin;

    const forwardedHost = request.headers.get("x-forwarded-host");
    const forwardedProto = request.headers.get("x-forwarded-proto");
    const effectiveOrigin =
      forwardedHost && forwardedProto
        ? `${forwardedProto}://${forwardedHost}`
        : new URL(request.url).origin;
    return new URL(origin).origin === new URL(effectiveOrigin).origin;
  } catch {
    return false;
  }
}

async function jellyfinIdentityAlreadyRegistered(jellyfinId: string): Promise<boolean> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  for (let page = 1; page <= 100; page += 1) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw error;
    if (
      data.users.some((user) =>
        constantTimeEqual(String(user.app_metadata?.jellyfin_user_id || ""), jellyfinId),
      )
    ) {
      return true;
    }
    if (data.users.length < 100) return false;
  }
  throw new Error("Refusing registration because the auth user scan exceeded 10,000 users");
}

async function createMailUser(
  username: string,
  displayName: string,
  password: string,
  jellyfinId: string,
): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email: `${username}${USERNAME_EMAIL_SUFFIX}`,
    password,
    email_confirm: true,
    user_metadata: {
      username,
      display_name: displayName.slice(0, 80),
    },
    app_metadata: {
      jorgarde_identity_source: "jellyfin",
      jellyfin_user_id: jellyfinId,
    },
  });
  if (error || !data.user) throw error || new Error("Auth did not return the created user");
}

async function assertAdministratorAlreadyProvisioned(): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("user_id")
    .eq("role", "admin")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Registration is unavailable until an administrator exists");
}

async function handleRegistration(request: Request): Promise<Response> {
  const startedAt = Date.now();
  const finish = async (response: Response): Promise<Response> => {
    const remaining = MIN_RESPONSE_TIME_MS - (Date.now() - startedAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    return response;
  };

  if (!sameOriginRequest(request)) return finish(genericFailure(403));

  let submitted: z.infer<typeof registration>;
  try {
    submitted = await readRegistration(request);
  } catch {
    return finish(genericFailure());
  }

  const username = submitted.jellyfinUsername.toLowerCase();
  const now = Date.now();
  pruneRateLimits(now);
  const ipKey = `ip:${requestIdentity(request)}`;
  const secret = process.env.INBOUND_WEBHOOK_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const userKey = `user:${createHmac("sha256", secret).update(username).digest("hex")}`;
  const withinIpLimit = consumeRateLimit(ipKey, MAX_IP_ATTEMPTS, now);
  const withinUserLimit = consumeRateLimit(userKey, MAX_USERNAME_ATTEMPTS, now);
  if (!withinIpLimit || !withinUserLimit) {
    return finish(genericFailure(429));
  }

  try {
    const { baseUrl, apiKey } = configuredJellyfin();
    const users = await fetchJellyfinUsers(baseUrl, apiKey);
    const matched = users.find(
      (candidate) =>
        typeof candidate.Name === "string" &&
        typeof candidate.Id === "string" &&
        candidate.Policy?.IsDisabled !== true &&
        constantTimeEqual(candidate.Name, submitted.jellyfinUsername),
    );

    // Authenticate even when the private list did not contain the name. This
    // keeps response shape/timing from turning registration into a user oracle.
    const authenticated = await authenticateJellyfinUser(
      baseUrl,
      typeof matched?.Name === "string" ? matched.Name : submitted.jellyfinUsername,
      submitted.jellyfinPassword,
      createHmac("sha256", secret).update(username).digest("hex").slice(0, 32),
    );
    const token = typeof authenticated?.AccessToken === "string" ? authenticated.AccessToken : "";
    if (token) await revokeJellyfinToken(baseUrl, token);

    const jellyfinId = typeof matched?.Id === "string" ? matched.Id : "";
    const authenticatedId =
      typeof authenticated?.User?.Id === "string" ? authenticated.User.Id : "";
    if (
      !matched ||
      !authenticated ||
      !jellyfinId ||
      !authenticatedId ||
      !constantTimeEqual(jellyfinId, authenticatedId)
    ) {
      return finish(genericFailure());
    }

    if (registrationLocks.has(jellyfinId)) return finish(genericFailure());
    registrationLocks.add(jellyfinId);
    try {
      if (await jellyfinIdentityAlreadyRegistered(jellyfinId)) {
        return finish(genericFailure());
      }
      // Keep registration closed until the installer creates the intended
      // administrator. The database trigger independently refuses to infer
      // admin rights from creation order.
      await assertAdministratorAlreadyProvisioned();
      await createMailUser(username, String(matched.Name), submitted.mailPassword, jellyfinId);
    } finally {
      registrationLocks.delete(jellyfinId);
    }

    return finish(json({ ok: true }, 201));
  } catch (error) {
    console.error("[registration] Jellyfin-gated registration failed", error);
    return finish(genericFailure());
  }
}

export const Route = createFileRoute("/api/public/register")({
  server: {
    handlers: {
      POST: async ({ request }) => handleRegistration(request),
    },
  },
});
