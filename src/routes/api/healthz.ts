import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/healthz")({
  server: {
    handlers: {
      GET: async () => {
        const backend = process.env.SUPABASE_URL?.replace(/\/$/, "");
        if (!backend) {
          return Response.json({ ok: false, error: "backend_not_configured" }, { status: 503 });
        }

        try {
          const response = await fetch(`${backend}/auth/v1/health`, {
            signal: AbortSignal.timeout(3_000),
          });
          if (!response.ok) {
            return Response.json(
              { ok: false, error: "auth_unhealthy", status: response.status },
              { status: 503 },
            );
          }
        } catch {
          return Response.json({ ok: false, error: "backend_unreachable" }, { status: 503 });
        }

        return Response.json({ ok: true });
      },
    },
  },
});
