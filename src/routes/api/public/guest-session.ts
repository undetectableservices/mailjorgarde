import { createHash } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const command = z
  .object({
    action: z.enum(["heartbeat", "close", "end"]),
    secret: z.string().regex(/^jg_[A-Za-z0-9_-]{43}$/),
  })
  .strict();

function reply(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export const Route = createFileRoute("/api/public/guest-session")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const rawBody = await request.text();
        if (new TextEncoder().encode(rawBody).byteLength > 1024) {
          return reply({ error: "payload_too_large" }, 413);
        }
        let body: unknown = null;
        try {
          body = JSON.parse(rawBody);
        } catch {
          return reply({ error: "invalid_request" }, 400);
        }
        const parsed = command.safeParse(body);
        if (!parsed.success) return reply({ error: "invalid_request" }, 400);

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const hash = createHash("sha256").update(parsed.data.secret).digest("hex");
        const { data: session } = await supabaseAdmin
          .from("guest_sessions")
          .select("user_id, expires_at")
          .eq("cleanup_secret_hash", hash)
          .maybeSingle();
        if (!session) return reply({ ok: true });

        if (parsed.data.action === "end") {
          await supabaseAdmin.auth.admin.deleteUser(session.user_id);
          return reply({ ok: true, deleted: true });
        }

        const now = new Date();
        if (Date.parse(session.expires_at) <= now.getTime()) {
          await supabaseAdmin.auth.admin.deleteUser(session.user_id);
          return reply({ ok: true, deleted: true });
        }
        const { error } = await supabaseAdmin
          .from("guest_sessions")
          .update({
            last_seen_at: now.toISOString(),
            delete_after:
              parsed.data.action === "close"
                ? new Date(now.getTime() + 2 * 60_000).toISOString()
                : null,
          })
          .eq("user_id", session.user_id);
        if (error) return reply({ error: "update_failed" }, 503);
        return reply({ ok: true });
      },
    },
  },
});
