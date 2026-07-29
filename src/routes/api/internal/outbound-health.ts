import { timingSafeEqual } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";

function authorized(request: Request) {
  const expected = Buffer.from((process.env.INBOUND_WEBHOOK_SECRET || "").trim(), "utf8");
  const provided = Buffer.from((request.headers.get("x-jorgarde-doctor") || "").trim(), "utf8");
  return (
    expected.length >= 24 &&
    provided.length === expected.length &&
    timingSafeEqual(provided, expected)
  );
}

export const Route = createFileRoute("/api/internal/outbound-health")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!authorized(request)) {
          return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
        }

        const { getOutboundRelayStatus, publicOutboundError, verifyOutboundRelay } =
          await import("@/lib/outbound-mail.server");
        const status = await getOutboundRelayStatus();
        if (!status.enabled) {
          return Response.json({ ok: true, enabled: false, configured: false });
        }

        try {
          const verified = await verifyOutboundRelay();
          return Response.json({ ok: true, ...verified });
        } catch (error) {
          const safe = publicOutboundError(error);
          return Response.json(
            { ok: false, enabled: true, configured: false, error: safe.code },
            { status: 503 },
          );
        }
      },
    },
  },
});
