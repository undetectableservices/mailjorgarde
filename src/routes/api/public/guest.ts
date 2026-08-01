import { createHash, createHmac, randomBytes } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";

const USERNAME_EMAIL_SUFFIX = "@users.jorgardemail.local";
const rate = new Map<string, { startedAt: number; count: number }>();

function reply(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function peerKey(request: Request): string {
  const address =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  const secret = process.env.INBOUND_WEBHOOK_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  return createHmac("sha256", secret).update(address).digest("hex");
}

function allowed(request: Request): boolean {
  const key = peerKey(request);
  const now = Date.now();
  const current = rate.get(key);
  if (!current || now - current.startedAt >= 10 * 60_000) {
    rate.set(key, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= 5;
}

export const Route = createFileRoute("/api/public/guest")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!allowed(request)) return reply({ error: "rate_limited" }, 429);
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const username = `guest-${randomBytes(6).toString("hex")}`;
        const password = randomBytes(32).toString("base64url");
        const cleanupSecret = `jg_${randomBytes(32).toString("base64url")}`;
        const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
        let userId: string | undefined;

        try {
          const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
            email: `${username}${USERNAME_EMAIL_SUFFIX}`,
            password,
            email_confirm: true,
            user_metadata: { username, display_name: "Invité" },
            app_metadata: { account_kind: "guest", guest_expires_at: expiresAt },
          });
          if (createError || !created.user) throw createError ?? new Error("guest_creation_failed");
          userId = created.user.id;

          const { error: profileError } = await supabaseAdmin
            .from("profiles")
            .update({
              account_kind: "guest",
              guest_expires_at: expiresAt,
              mailbox_limit: 3,
              api_access: false,
            })
            .eq("user_id", userId);
          if (profileError) throw profileError;

          const { data: domains, error: domainError } = await supabaseAdmin
            .from("domains")
            .select("id, name, expires_at")
            .order("name");
          if (domainError) throw domainError;
          const now = Date.now();
          const available = (domains ?? []).filter(
            (domain) => !domain.expires_at || Date.parse(domain.expires_at) > now,
          );
          if (available.length === 0) throw new Error("no_domain_available");

          const addresses: Array<{ id: string; address: string }> = [];
          for (let index = 0; index < 3; index += 1) {
            const domain = available[index % available.length];
            let inserted = false;
            for (let attempt = 0; attempt < 6 && !inserted; attempt += 1) {
              const localPart = `guest-${randomBytes(8).toString("hex")}`;
              const { data: mailbox, error } = await supabaseAdmin
                .from("mailboxes")
                .insert({
                  user_id: userId,
                  local_part: localPart,
                  domain_id: domain.id,
                  is_temp: true,
                  expires_at: expiresAt,
                })
                .select("id")
                .single();
              if (error?.code === "23505") continue;
              if (error || !mailbox) throw error ?? new Error("mailbox_creation_failed");
              addresses.push({ id: mailbox.id, address: `${localPart}@${domain.name}` });
              inserted = true;
            }
            if (!inserted) throw new Error("mailbox_creation_failed");
          }

          const { error: sessionError } = await supabaseAdmin.from("guest_sessions").insert({
            user_id: userId,
            cleanup_secret_hash: createHash("sha256").update(cleanupSecret).digest("hex"),
            expires_at: expiresAt,
          });
          if (sessionError) throw sessionError;

          return reply(
            { username, password, cleanup_secret: cleanupSecret, expires_at: expiresAt, addresses },
            201,
          );
        } catch (error) {
          if (userId) await supabaseAdmin.auth.admin.deleteUser(userId).catch(() => undefined);
          console.error("[guest] creation failed", error);
          return reply({ error: "guest_creation_failed" }, 503);
        }
      },
    },
  },
});
