import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

type AuthedContext = { supabase: SupabaseClient<Database>; userId: string };

async function assertAdmin(context: AuthedContext) {
  const { data, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "admin",
  });
  if (error || !data) throw new Error("Accès administrateur requis");
}

const revision = z.number().int().min(0);
const jellyfinInput = z
  .object({
    expectedRevision: revision,
    enabled: z.boolean(),
    url: z.string().trim().max(2048),
    apiKey: z.string().max(512).optional(),
  })
  .strict();
const jellyfinTestInput = jellyfinInput.omit({ expectedRevision: true, enabled: true });

const smtpInput = z
  .object({
    expectedRevision: revision,
    enabled: z.boolean(),
    host: z.string().trim().toLowerCase().max(253),
    port: z.union([z.literal(465), z.literal(587)]),
    security: z.enum(["starttls", "tls"]),
    username: z.string().trim().max(512),
    password: z.string().max(2048).optional(),
    maxRecipients: z.number().int().min(1).max(50),
  })
  .strict();
const smtpTestInput = smtpInput.omit({ expectedRevision: true, enabled: true });

export const getAdminControlState = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const { getAdminRuntimeConfigurationState } = await import("./runtime-configuration.server");
    return getAdminRuntimeConfigurationState();
  });

export const testJellyfinConfiguration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((value: unknown) => jellyfinTestInput.parse(value))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { loadEffectiveJellyfinConfiguration } = await import("./runtime-configuration.server");
    const { normalizeJellyfinConfiguration, testJellyfinConnection } =
      await import("./jellyfin.server");
    const current = await loadEffectiveJellyfinConfiguration();
    const candidate = normalizeJellyfinConfiguration(
      data.url,
      data.apiKey?.trim() || current.apiKey,
    );
    return testJellyfinConnection(candidate);
  });

export const saveJellyfinConfiguration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((value: unknown) => jellyfinInput.parse(value))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { loadEffectiveJellyfinConfiguration, saveJellyfinRuntimeConfiguration } =
      await import("./runtime-configuration.server");
    const { normalizeJellyfinConfiguration, testJellyfinConnection } =
      await import("./jellyfin.server");
    const current = await loadEffectiveJellyfinConfiguration();
    const suppliedKey = data.apiKey?.trim();
    let test = null;
    let normalizedUrl = data.url;
    if (data.enabled) {
      const candidate = normalizeJellyfinConfiguration(data.url, suppliedKey || current.apiKey);
      test = await testJellyfinConnection(candidate);
      normalizedUrl = candidate.baseUrl;
    }
    const state = await saveJellyfinRuntimeConfiguration(context.userId, {
      expectedRevision: data.expectedRevision,
      managed: true,
      enabled: data.enabled,
      url: normalizedUrl,
      apiKey: suppliedKey || undefined,
    });
    return { state, test };
  });

export const resetJellyfinConfiguration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((value: unknown) => z.object({ expectedRevision: revision }).strict().parse(value))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { saveJellyfinRuntimeConfiguration } = await import("./runtime-configuration.server");
    return saveJellyfinRuntimeConfiguration(context.userId, {
      expectedRevision: data.expectedRevision,
      managed: false,
      enabled: false,
      url: "",
    });
  });

async function smtpCandidate(data: z.infer<typeof smtpTestInput>) {
  const { loadEffectiveSmtpConfiguration } = await import("./runtime-configuration.server");
  const current = await loadEffectiveSmtpConfiguration();
  return {
    enabled: true,
    host: data.host,
    port: data.port,
    security: data.security,
    username: data.username,
    password: data.password || current.password,
    maxRecipients: data.maxRecipients,
    heloName: (process.env.MAIL_HOSTNAME || "").trim() || undefined,
    source: "panel" as const,
  };
}

export const testSmtpConfiguration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((value: unknown) => smtpTestInput.parse(value))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { publicOutboundError, verifyOutboundRelayConfiguration } =
      await import("./outbound-mail.server");
    try {
      return await verifyOutboundRelayConfiguration(await smtpCandidate(data));
    } catch (error) {
      throw new Error(publicOutboundError(error).message);
    }
  });

export const saveSmtpConfiguration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((value: unknown) => smtpInput.parse(value))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    let test = null;
    if (data.enabled) {
      const { publicOutboundError, verifyOutboundRelayConfiguration } =
        await import("./outbound-mail.server");
      try {
        test = await verifyOutboundRelayConfiguration(await smtpCandidate(data));
      } catch (error) {
        throw new Error(publicOutboundError(error).message);
      }
    }
    const { saveSmtpRuntimeConfiguration } = await import("./runtime-configuration.server");
    const suppliedPassword = data.password || undefined;
    const state = await saveSmtpRuntimeConfiguration(context.userId, {
      expectedRevision: data.expectedRevision,
      managed: true,
      enabled: data.enabled,
      host: data.host,
      port: data.port,
      security: data.security,
      username: data.username,
      password: suppliedPassword,
      maxRecipients: data.maxRecipients,
    });
    return { state, test };
  });

export const resetSmtpConfiguration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((value: unknown) => z.object({ expectedRevision: revision }).strict().parse(value))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { saveSmtpRuntimeConfiguration } = await import("./runtime-configuration.server");
    return saveSmtpRuntimeConfiguration(context.userId, {
      expectedRevision: data.expectedRevision,
      managed: false,
      enabled: false,
      host: "",
      port: 587,
      security: "starttls",
      username: "",
      maxRecipients: 25,
    });
  });
