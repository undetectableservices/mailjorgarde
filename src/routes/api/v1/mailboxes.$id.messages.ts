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
          const { authenticateDeveloperApi, findOwnedApiMailbox, logApiActivity } =
            await import("@/lib/api-access.server");
          const identity = await authenticateDeveloperApi(request);
          if (!identity) return reply({ error: "unauthorized" }, 401);
          const mailbox = await findOwnedApiMailbox(identity.userId, params.id);
          if (!mailbox) return reply({ error: "mailbox_not_found" }, 404);

          const url = new URL(request.url);
          const limit = Math.floor(
            Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100)),
          );
          const before = url.searchParams.get("before");
          if (before && Number.isNaN(Date.parse(before))) {
            return reply({ error: "invalid_cursor" }, 400);
          }
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          let query = supabaseAdmin
            .from("messages")
            .select(
              "id, sender, recipient_addr, subject, body_text, body_html, received_at, size_bytes, attachments(id, filename, mime, size, content_id, content_disposition)",
            )
            .eq("mailbox_id", params.id)
            .eq("folder", "inbox")
            .order("received_at", { ascending: false })
            .limit(limit);
          if (before) query = query.lt("received_at", new Date(before).toISOString());
          const { data: messages, error } = await query;
          if (error) throw error;
          const rows = messages ?? [];
          const nextBefore = rows.length === limit ? (rows.at(-1)?.received_at ?? null) : null;
          await logApiActivity({
            userId: identity.userId,
            keyId: identity.keyId,
            request,
            action: "messages_read",
            mailboxId: mailbox.id,
            address: mailbox.address,
            metadata: { count: rows.length, limit, paginated: Boolean(before) },
          });
          return reply({
            mailbox,
            messages: rows,
            pagination: { limit, next_before: nextBefore },
            warning: "body_html est non fiable: assainissez-le et utilisez une iframe isolée.",
          });
        } catch (error) {
          console.error("[developer-api] message retrieval failed", error);
          return reply({ error: "internal_error" }, 500);
        }
      },
    },
  },
});
