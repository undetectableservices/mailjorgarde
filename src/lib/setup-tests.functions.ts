import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import { z } from "zod";

const dnsType = z.enum(["A", "AAAA", "MX", "TXT"]);

type AuthedContext = {
  supabase: SupabaseClient<Database>;
  userId: string;
};

async function assertAdmin(context: AuthedContext) {
  const { data: isAdmin, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "admin",
  });
  if (error) throw new Error(error.message);
  if (!isAdmin) throw new Error("Accès administrateur requis");
}

/** Which server-side settings the stack needs, reported as set/unset only. */
export const checkServerEnv = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const has = (k: string) => Boolean(process.env[k] && process.env[k]!.length > 0);
    return {
      ip: process.env.PUBLIC_IP ?? null,
      webHostname: process.env.WEB_HOSTNAME ?? null,
      mailHostname: process.env.MAIL_HOSTNAME ?? null,
      mode: process.env.DEPLOYMENT_MODE ?? null,
      env: {
        SUPABASE_URL: has("SUPABASE_URL"),
        SUPABASE_PUBLISHABLE_KEY: has("SUPABASE_PUBLISHABLE_KEY"),
        SUPABASE_SERVICE_ROLE_KEY: has("SUPABASE_SERVICE_ROLE_KEY"),
        INBOUND_WEBHOOK_SECRET: has("INBOUND_WEBHOOK_SECRET"),
        JELLYFIN_URL: has("JELLYFIN_URL"),
        JELLYFIN_API_KEY: has("JELLYFIN_API_KEY"),
        OUTBOUND_SMTP_ENABLED:
          (process.env.OUTBOUND_SMTP_ENABLED || "false").toLowerCase() === "true",
        OUTBOUND_SMTP_HOST: has("OUTBOUND_SMTP_HOST"),
        OUTBOUND_SMTP_USERNAME: has("OUTBOUND_SMTP_USERNAME"),
        OUTBOUND_SMTP_PASSWORD: has("OUTBOUND_SMTP_PASSWORD_B64"),
      },
    };
  });

/** Authenticate to the configured relay without sending a message. */
export const checkOutboundRelay = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const { verifyOutboundRelay } = await import("./outbound-mail.server");
    return verifyOutboundRelay();
  });

/**
 * Probe the SMTP container directly. A connection to MAIL_HOSTNAME:25 from
 * inside this stack is a NAT-hairpin test, not proof of public reachability,
 * and commonly fails on otherwise-correct routers.
 */
export const checkSmtpListener = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: unknown) =>
    z
      .object({
        banner: z.boolean().optional(),
      })
      .strict()
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { probeTcp } = await import("./setup-tests.server");
    return probeTcp("smtp", 2525, data.banner ?? false);
  });

/** DNS lookup through this server's resolver; unlike public DoH this leaks no setup data to Google. */
export const checkDns = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: unknown) =>
    z
      .object({
        name: z
          .string()
          .trim()
          .toLowerCase()
          .min(1)
          .max(253)
          .regex(
            /^(?=.{1,253}\.?$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/,
          ),
        type: dnsType,
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { resolveDnsRecords } = await import("./setup-tests.server");
    try {
      return { records: await resolveDnsRecords(data.name.replace(/\.$/, ""), data.type) };
    } catch (error) {
      const code =
        error != null && typeof error === "object" && "code" in error
          ? String(error.code)
          : "DNS_ERROR";
      if (["ENODATA", "ENOTFOUND", "ENODOMAIN"].includes(code)) return { records: [] };
      throw error;
    }
  });

/** End-to-end delivery test: writes a message straight into a real mailbox. */
export const sendTestDelivery = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: unknown) => z.object({ to: z.string().trim().email() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [local, domain] = data.to.toLowerCase().split("@");

    const { data: dom } = await supabaseAdmin
      .from("domains")
      .select("id")
      .eq("name", domain)
      .maybeSingle();
    if (!dom)
      throw new Error(
        `Le domaine « ${domain} » n’est pas géré par ce serveur. Ajoutez-le à l’étape Domaines.`,
      );
    const { data: mb } = await supabaseAdmin
      .from("mailboxes")
      .select("id")
      .eq("local_part", local)
      .eq("domain_id", dom.id)
      .maybeSingle();
    if (!mb) throw new Error(`L’adresse « ${data.to} » n’existe pas encore.`);

    const body =
      "Ceci est un test de réception JorgardeMail. Si vous pouvez le lire, le stockage et le classement fonctionnent.";
    const { error } = await supabaseAdmin.from("messages").insert({
      mailbox_id: mb.id,
      sender: "Assistant JorgardeMail <setup@jorgardemail>",
      recipient_addr: data.to,
      subject: "Test de réception ✓",
      body_text: body,
      folder: "inbox",
      size_bytes: body.length,
    });
    if (error) throw new Error("Impossible d’enregistrer le message de test");
    return { ok: true, to: data.to };
  });

/** Quick backend health snapshot. */
export const checkBackend = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [users, domains, mailboxes, messages] = await Promise.all([
      supabaseAdmin.from("profiles").select("user_id", { count: "exact", head: true }),
      supabaseAdmin.from("domains").select("id", { count: "exact", head: true }),
      supabaseAdmin.from("mailboxes").select("id", { count: "exact", head: true }),
      supabaseAdmin.from("messages").select("id", { count: "exact", head: true }),
    ]);
    const err = users.error || domains.error || mailboxes.error || messages.error;
    if (err) throw new Error("Impossible de lire l’état des services");
    return {
      users: users.count ?? 0,
      domains: domains.count ?? 0,
      mailboxes: mailboxes.count ?? 0,
      messages: messages.count ?? 0,
    };
  });
