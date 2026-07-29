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
