import { createFileRoute } from "@tanstack/react-router";

function reply(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export const Route = createFileRoute("/api/v1/logs")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const { authenticateDeveloperApi, listOwnedApiLogs, logApiActivity } =
            await import("@/lib/api-access.server");
          const identity = await authenticateDeveloperApi(request);
          if (!identity) return reply({ error: "unauthorized" }, 401);
          const url = new URL(request.url);
          const limit = Math.min(
            500,
            Math.max(1, Math.floor(Number(url.searchParams.get("limit")) || 100)),
          );
          const logs = await listOwnedApiLogs(identity.userId, limit);
          await logApiActivity({
            userId: identity.userId,
            keyId: identity.keyId,
            request,
            action: "activity_logs_read",
            metadata: { count: logs.length, limit },
          });
          return reply({ logs, total_returned: logs.length });
        } catch (error) {
          console.error("[developer-api] activity log retrieval failed", error);
          return reply({ error: "internal_error" }, 500);
        }
      },
    },
  },
});
