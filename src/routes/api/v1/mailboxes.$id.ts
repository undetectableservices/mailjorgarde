import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

function reply(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export const Route = createFileRoute("/api/v1/mailboxes/$id")({
  server: {
    handlers: {
      DELETE: async ({ request, params }) => {
        try {
          if (!z.string().uuid().safeParse(params.id).success) {
            return reply({ error: "invalid_mailbox_id" }, 400);
          }
          const { authenticateDeveloperApi, deleteOwnedApiMailbox, logApiActivity } =
            await import("@/lib/api-access.server");
          const identity = await authenticateDeveloperApi(request);
          if (!identity) return reply({ error: "unauthorized" }, 401);
          const mailbox = await deleteOwnedApiMailbox(identity.userId, params.id);
          if (!mailbox) return reply({ error: "mailbox_not_found" }, 404);
          await logApiActivity({
            userId: identity.userId,
            keyId: identity.keyId,
            request,
            action: "mailbox_deleted",
            mailboxId: params.id,
            address: mailbox.address,
          });
          return reply({ deleted: true, mailbox });
        } catch (error) {
          console.error("[developer-api] mailbox deletion failed", error);
          return reply({ error: "internal_error" }, 500);
        }
      },
    },
  },
});
