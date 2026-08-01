import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import type { DeveloperApiIdentity } from "@/lib/api-access.server";

const bodySchema = z
  .object({
    local_part: z.string().trim().min(1).max(64).optional(),
    domain: z.string().trim().min(1).max(253).optional(),
  })
  .strict();

function reply(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function creationError(code: string): { status: number; error: string } {
  if (code === "invalid_local_part") return { status: 400, error: code };
  if (code === "forbidden") return { status: 403, error: code };
  if (
    [
      "address_already_exists",
      "api_mailbox_limit_reached",
      "domain_unavailable",
      "no_domain_available",
    ].includes(code)
  ) {
    return { status: 409, error: code };
  }
  return { status: 500, error: "internal_error" };
}

export const Route = createFileRoute("/api/v1/mailboxes")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        let identity: DeveloperApiIdentity | null = null;
        try {
          const { authenticateDeveloperApi, listOwnedApiMailboxes, logApiActivity } =
            await import("@/lib/api-access.server");
          identity = await authenticateDeveloperApi(request);
          if (!identity) return reply({ error: "unauthorized" }, 401);
          const mailboxes = await listOwnedApiMailboxes(identity.userId);
          await logApiActivity({
            userId: identity.userId,
            keyId: identity.keyId,
            request,
            action: "mailboxes_listed",
            metadata: { count: mailboxes.length },
          });
          return reply({ mailboxes, total: mailboxes.length, maximum: 1000 });
        } catch (error) {
          console.error("[developer-api] mailbox listing failed", error);
          return reply({ error: "internal_error" }, 500);
        }
      },
      POST: async ({ request }) => {
        let identity: DeveloperApiIdentity | null = null;
        try {
          const { authenticateDeveloperApi, createApiMailbox, logApiActivity } =
            await import("@/lib/api-access.server");
          identity = await authenticateDeveloperApi(request);
          if (!identity) return reply({ error: "unauthorized" }, 401);
          const rawBody = await request.text();
          if (new TextEncoder().encode(rawBody).byteLength > 2048) {
            return reply({ error: "payload_too_large" }, 413);
          }
          let body: unknown = {};
          try {
            body = rawBody ? JSON.parse(rawBody) : {};
          } catch {
            return reply({ error: "invalid_request" }, 400);
          }
          const parsed = bodySchema.safeParse(body);
          if (!parsed.success) return reply({ error: "invalid_request" }, 400);
          const mailbox = await createApiMailbox(identity.userId, {
            localPart: parsed.data.local_part,
            domain: parsed.data.domain,
          });
          await logApiActivity({
            userId: identity.userId,
            keyId: identity.keyId,
            request,
            action: parsed.data.local_part ? "custom_mailbox_created" : "random_mailbox_created",
            mailboxId: mailbox.id,
            address: mailbox.address,
            status: 201,
            metadata: { custom: Boolean(parsed.data.local_part) },
          });
          return reply({ mailbox, total_maximum: 1000 }, 201);
        } catch (error) {
          const code = error instanceof Error ? error.message : "internal_error";
          const mapped = creationError(code);
          if (identity) {
            const { logApiActivity } = await import("@/lib/api-access.server");
            await logApiActivity({
              userId: identity.userId,
              keyId: identity.keyId,
              request,
              action: "mailbox_creation_failed",
              status: mapped.status,
              metadata: { error: mapped.error },
            });
          }
          if (mapped.status === 500) {
            console.error("[developer-api] mailbox creation failed", error);
          }
          return reply({ error: mapped.error }, mapped.status);
        }
      },
    },
  },
});
