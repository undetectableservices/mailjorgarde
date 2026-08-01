import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

function reply(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export const Route = createFileRoute("/api/v1/mailboxes/$id/messages")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          if (!z.string().uuid().safeParse(params.id).success) {
            return reply({ error: "invalid_mailbox_id" }, 400);
          }
          const { authenticateDeveloperApi } = await import("@/lib/api-access.server");
          const identity = await authenticateDeveloperApi(request, "read");
          if (!identity) return reply({ error: "unauthorized" }, 401);
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { data: link } = await supabaseAdmin
            .from("api_mailboxes")
            .select("mailbox:mailboxes(id, local_part, expires_at, domain:domains(name))")
            .eq("mailbox_id", params.id)
            .eq("user_id", identity.userId)
            .maybeSingle();
          if (!link?.mailbox) return reply({ error: "mailbox_not_found" }, 404);
          if (link.mailbox.expires_at && Date.parse(link.mailbox.expires_at) <= Date.now()) {
            return reply({ error: "mailbox_expired" }, 410);
          }
          const url = new URL(request.url);
          const limit = Math.floor(
            Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50)),
          );
          const { data: messages, error } = await supabaseAdmin
            .from("messages")
            .select(
              "id, sender, recipient_addr, subject, body_text, body_html, received_at, size_bytes, attachments(id, filename, mime, size, content_id, content_disposition)",
            )
            .eq("mailbox_id", params.id)
            .eq("folder", "inbox")
            .order("received_at", { ascending: false })
            .limit(limit);
          if (error) throw error;
          return reply({
            mailbox: {
              id: link.mailbox.id,
              address: `${link.mailbox.local_part}@${link.mailbox.domain?.name}`,
              expires_at: link.mailbox.expires_at,
            },
            messages: messages ?? [],
            warning: "body_html est du contenu non fiable et doit être assaini avant affichage.",
          });
        } catch (error) {
          if (error instanceof Error && error.message === "rate_limited") {
            return reply({ error: "rate_limited" }, 429);
          }
          console.error("[developer-api] message retrieval failed", error);
          return reply({ error: "internal_error" }, 500);
        }
      },
    },
  },
});
