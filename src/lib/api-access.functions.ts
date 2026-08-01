import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertApiAllowed(userId: string): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const [{ data: profile }, { data: role }] = await Promise.all([
    supabaseAdmin
      .from("profiles")
      .select("api_access, account_kind")
      .eq("user_id", userId)
      .single(),
    supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "admin")
      .maybeSingle(),
  ]);
  if (profile?.account_kind !== "member" || (!profile.api_access && !role)) {
    throw new Error("L’accès API n’est pas activé pour votre compte");
  }
}

export const listApiKeys = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertApiAllowed(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("api_keys")
      .select("id, name, key_prefix, created_at, last_used_at")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const createApiKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ name: z.string().trim().min(1).max(80) }))
  .handler(async ({ data, context }) => {
    await assertApiAllowed(context.userId);
    const { hashApiSecret, newApiSecret } = await import("@/lib/api-access.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { count } = await supabaseAdmin
      .from("api_keys")
      .select("id", { count: "exact", head: true })
      .eq("user_id", context.userId);
    if ((count ?? 0) >= 5) throw new Error("Maximum de 5 clés API atteint");

    const secret = newApiSecret();
    const { data: inserted, error } = await supabaseAdmin
      .from("api_keys")
      .insert({
        user_id: context.userId,
        name: data.name,
        key_hash: hashApiSecret(secret),
        key_prefix: secret.slice(0, 14),
      })
      .select("id, name, key_prefix, created_at")
      .single();
    if (error) throw new Error(error.message);
    return { ...inserted, secret };
  });

export const revokeApiKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data, context }) => {
    await assertApiAllowed(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("api_keys")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
