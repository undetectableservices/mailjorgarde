import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

const USERNAME_EMAIL_SUFFIX = "@users.jorgardemail.local";
const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{1,22}[a-z0-9]$/, {
    message: "L’identifiant doit contenir 3 à 24 lettres, chiffres, _ ou -",
  });
const password = z.string().min(12).max(128);
const banSchema = z.object({
  userId: z.string().uuid(),
  duration: z.enum(["1h", "24h", "7d", "permanent", "none"]),
});
const apiAccessSchema = z.object({ userId: z.string().uuid(), enabled: z.boolean() });
const mailboxIdSchema = z.object({ mailboxId: z.string().uuid() });
const userIdSchema = z.object({ userId: z.string().uuid() });

type AuthedContext = {
  supabase: SupabaseClient<Database>;
  userId: string;
};

async function assertAdmin(context: AuthedContext): Promise<void> {
  const { data, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "admin",
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Accès administrateur requis");
}

export const createLocalUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    z.object({
      username,
      displayName: z.string().trim().min(1).max(80).optional(),
      password,
    }),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
      email: `${data.username}${USERNAME_EMAIL_SUFFIX}`,
      password: data.password,
      email_confirm: true,
      user_metadata: {
        username: data.username,
        display_name: data.displayName || data.username,
      },
    });
    if (error) throw new Error(error.message);
    if (!created.user)
      throw new Error("Le service d’authentification n’a pas renvoyé le compte créé");
    return { id: created.user.id, username: data.username };
  });

export const resetLocalUserPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ userId: z.string().uuid(), password }))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.auth.admin.updateUserById(data.userId, {
      password: data.password,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const setLocalUserBan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(banSchema)
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    if (data.userId === context.userId) {
      throw new Error("Vous ne pouvez pas bannir votre propre compte");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const durations = {
      "1h": "1h",
      "24h": "24h",
      "7d": "168h",
      permanent: "876000h",
      none: "none",
    } as const;
    const { data: updated, error } = await supabaseAdmin.auth.admin.updateUserById(data.userId, {
      // GoTrue uses Go-style durations. One hundred years acts as a permanent
      // ban while "none" explicitly restores authentication.
      ban_duration: durations[data.duration],
    });
    if (error) throw new Error(error.message);
    if (!updated.user) throw new Error("Le compte demandé est introuvable");

    const durationMs = {
      "1h": 60 * 60_000,
      "24h": 24 * 60 * 60_000,
      "7d": 7 * 24 * 60 * 60_000,
      permanent: 100 * 365 * 24 * 60 * 60_000,
      none: 0,
    }[data.duration];
    const suspendedUntil = durationMs ? new Date(Date.now() + durationMs).toISOString() : null;
    const { error: profileError } = await supabaseAdmin
      .from("profiles")
      .update({ suspended_until: suspendedUntil })
      .eq("user_id", data.userId);
    if (profileError) throw new Error(profileError.message);

    return {
      userId: updated.user.id,
      banned: data.duration !== "none",
      bannedUntil: suspendedUntil,
    };
  });

export const setUserApiAccess = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(apiAccessSchema)
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ api_access: data.enabled })
      .eq("user_id", data.userId)
      .eq("account_kind", "member");
    if (error) throw new Error(error.message);
    if (!data.enabled) {
      await supabaseAdmin.from("api_keys").delete().eq("user_id", data.userId);
    }
    const { logApiActivity } = await import("@/lib/api-access.server");
    await logApiActivity({
      userId: data.userId,
      action: data.enabled ? "api_access_granted" : "api_access_revoked",
      metadata: { changed_by_admin: context.userId },
    });
    return { userId: data.userId, enabled: data.enabled };
  });

export const deleteUserMailbox = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(mailboxIdSchema)
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: mailbox, error: lookupError } = await supabaseAdmin
      .from("mailboxes")
      .select("id, local_part, domain:domains(name)")
      .eq("id", data.mailboxId)
      .maybeSingle();
    if (lookupError || !mailbox) throw new Error("Adresse introuvable");
    if (["postmaster", "abuse"].includes(mailbox.local_part)) {
      throw new Error(
        "Les adresses postmaster et abuse sont obligatoires et ne peuvent pas être supprimées",
      );
    }
    const { error } = await supabaseAdmin.from("mailboxes").delete().eq("id", mailbox.id);
    if (error) throw new Error(error.message);
    return { address: `${mailbox.local_part}@${mailbox.domain?.name ?? ""}` };
  });

export const deleteLocalUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(userIdSchema)
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    if (data.userId === context.userId) {
      throw new Error("Vous ne pouvez pas supprimer votre propre compte");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("username")
      .eq("user_id", data.userId)
      .maybeSingle();
    // Preserve RFC-required role addresses if another administrator happened
    // to own them. The current administrator becomes their owner before the
    // auth cascade removes the target account.
    const { error: aliasError } = await supabaseAdmin
      .from("mailboxes")
      .update({ user_id: context.userId })
      .eq("user_id", data.userId)
      .in("local_part", ["postmaster", "abuse"]);
    if (aliasError) throw new Error(aliasError.message);
    const { error } = await supabaseAdmin.auth.admin.deleteUser(data.userId);
    if (error) throw new Error(error.message);
    return { userId: data.userId, username: profile?.username ?? "utilisateur" };
  });
