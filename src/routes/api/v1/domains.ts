import { createFileRoute } from "@tanstack/react-router";

function reply(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export const Route = createFileRoute("/api/v1/domains")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const { authenticateDeveloperApi, listAvailableApiDomains, logApiActivity } =
            await import("@/lib/api-access.server");
          const identity = await authenticateDeveloperApi(request);
          if (!identity) return reply({ error: "unauthorized" }, 401);
          const domains = await listAvailableApiDomains();
          await logApiActivity({
            userId: identity.userId,
            keyId: identity.keyId,
            request,
            action: "domains_listed",
            metadata: { count: domains.length },
          });
          return reply({ domains, total: domains.length });
        } catch (error) {
          console.error("[developer-api] domain listing failed", error);
          return reply({ error: "internal_error" }, 500);
        }
      },
    },
  },
});
