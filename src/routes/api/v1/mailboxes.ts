import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const bodySchema = z
  .object({ ttl_minutes: z.number().int().min(10).max(1440).default(60) })
  .strict();

function reply(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export const Route = createFileRoute("/api/v1/mailboxes")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const { authenticateDeveloperApi, createRandomApiMailbox } =
            await import("@/lib/api-access.server");
          const identity = await authenticateDeveloperApi(request, "create");
          if (!identity) return reply({ error: "unauthorized" }, 401);
          const rawBody = await request.text();
          if (new TextEncoder().encode(rawBody).byteLength > 1024) {
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
          const mailbox = await createRandomApiMailbox(identity.userId, parsed.data.ttl_minutes);
          return reply({ mailbox }, 201);
        } catch (error) {
          const code = error instanceof Error ? error.message : "internal_error";
          if (code === "rate_limited") return reply({ error: code }, 429);
          if (["mailbox_limit_reached", "no_domain_available"].includes(code)) {
            return reply({ error: code }, 409);
          }
          console.error("[developer-api] mailbox creation failed", error);
          return reply({ error: "internal_error" }, 500);
        }
      },
    },
  },
});
