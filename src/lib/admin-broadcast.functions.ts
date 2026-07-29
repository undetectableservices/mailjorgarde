import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import { z } from "zod";

const schema = z.object({
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20000),
});

const mailboxLimitSchema = z.object({
  userId: z.string().uuid(),
  limit: z.number().int().min(0).max(1000),
});

async function assertAdmin(context: { supabase: SupabaseClient<Database>; userId: string }) {
  const { data: isAdmin, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "admin",
  });
  if (error) throw new Error(error.message);
  if (!isAdmin) throw new Error("Forbidden");
}

export const broadcastToAllUsers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) => schema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    await assertAdmin({ supabase, userId });

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Pick one mailbox per user (earliest created) so the broadcast lands
    // in each user's unified inbox exactly once.
    const { data: boxes, error: boxErr } = await supabaseAdmin
      .from("mailboxes")
      .select("id, user_id, local_part, domain:domains(name), created_at")
      .order("created_at", { ascending: true });
    if (boxErr) throw new Error(boxErr.message);

    const perUser = new Map<string, { id: string; addr: string }>();
    for (const b of boxes ?? []) {
      if (perUser.has(b.user_id)) continue;
      const addr = `${b.local_part}@${b.domain?.name ?? "local"}`;
      perUser.set(b.user_id, { id: b.id, addr });
    }
    if (perUser.size === 0) return { sent: 0 };

    const now = new Date().toISOString();
    const rows = Array.from(perUser.values()).map((b) => ({
      mailbox_id: b.id,
      sender: "JorgardeMail Admin <admin@jorgardemail>",
      recipient_addr: b.addr,
      subject: data.subject,
      body_text: data.body,
      folder: "inbox",
      seen: false,
      starred: false,
      size_bytes: data.body.length + data.subject.length,
      received_at: now,
    }));

    // Insert in chunks to stay well under any request size limits.
    const chunkSize = 200;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const { error } = await supabaseAdmin.from("messages").insert(rows.slice(i, i + chunkSize));
      if (error) throw new Error(error.message);
    }

    return { sent: rows.length };
  });

/** Aggregate-only admin view. Message bodies never cross this boundary. */
export const getAdminUserStats = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const { data, error } = await context.supabase.rpc("admin_user_stats", {});
    if (error) throw new Error(error.message);

    const users = (data ?? []).map((row) => ({
      ...row,
      mailbox_count: Number(row.mailbox_count ?? 0),
      storage_bytes: Number(row.storage_bytes ?? 0),
      addresses: row.addresses ?? [],
    }));
    return {
      users,
      total: users.reduce((sum, user) => sum + user.storage_bytes, 0),
      totalBoxes: users.reduce((sum, user) => sum + user.mailbox_count, 0),
    };
  });

/** Mailbox quota is security-sensitive and cannot be updated through profiles. */
export const setAdminMailboxLimit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) => mailboxLimitSchema.parse(data))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { data: applied, error } = await context.supabase.rpc("admin_set_mailbox_limit", {
      p_user_id: data.userId,
      p_limit: data.limit,
    });
    if (error) throw new Error(error.message);
    return { userId: data.userId, limit: applied };
  });
