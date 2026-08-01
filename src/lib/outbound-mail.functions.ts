import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const emailAddress = z.string().trim().toLowerCase().max(254).email("Adresse e-mail invalide");

const outboundMessageSchema = z
  .object({
    requestId: z.string().uuid(),
    mailboxId: z.string().uuid(),
    to: z.array(emailAddress).min(1).max(50),
    cc: z.array(emailAddress).max(50).default([]),
    bcc: z.array(emailAddress).max(50).default([]),
    subject: z.string().trim().max(998).default(""),
    body: z.string().trim().min(1, "Le message est vide").max(200_000),
    inReplyTo: z
      .string()
      .trim()
      .max(998)
      .refine((value) => !/[\r\n]/.test(value), "Référence de réponse invalide")
      .optional(),
  })
  .strict();

function deduplicateRecipients(to: string[], cc: string[], bcc: string[]) {
  const seen = new Set<string>();
  const unique = (items: string[]) =>
    items.filter((address) => {
      const key = address.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return { to: unique(to), cc: unique(cc), bcc: unique(bcc) };
}

function signatureBody(body: string, signature: string | null, placement: string | null): string {
  const cleanSignature = (signature || "").trim();
  if (!cleanSignature || placement === "none") return body;
  return `${body}\n\n-- \n${cleanSignature}`;
}

function safeReservationError(message: string) {
  if (message.includes("Outbound rate limit exceeded")) {
    return "Limite d'envoi atteinte. Attendez avant de réessayer.";
  }
  if (message.includes("Mailbox unavailable")) {
    return "Cette adresse d'envoi n'est plus disponible.";
  }
  return "Impossible de préparer l'envoi pour le moment.";
}

export const getOutboundRelayInfo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { getOutboundRelayStatus } = await import("./outbound-mail.server");
    const status = await getOutboundRelayStatus();
    return {
      enabled: status.enabled,
      configured: status.configured,
      maxRecipients: status.maxRecipients,
    };
  });

export const sendOutboundEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) => outboundMessageSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: senderProfile } = await supabaseAdmin
      .from("profiles")
      .select("account_kind")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (senderProfile?.account_kind === "guest") {
      throw new Error("Les comptes invités peuvent uniquement recevoir des e-mails.");
    }
    const { deliverOutboundMessage, getOutboundRelayStatus, publicOutboundError } =
      await import("./outbound-mail.server");
    const relayStatus = await getOutboundRelayStatus();
    if (!relayStatus.enabled || !relayStatus.configured) {
      throw new Error("L'envoi externe n'est pas encore configuré par l'administrateur.");
    }
    const recipientLimit = relayStatus.maxRecipients;

    const { data: mailbox, error: mailboxError } = await context.supabase
      .from("mailboxes")
      .select(
        "id, user_id, local_part, display_name, signature, signature_placement, auto_bcc, is_temp, expires_at, domain:domains(name, expires_at)",
      )
      .eq("id", data.mailboxId)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (mailboxError) throw new Error("Impossible de vérifier l'adresse d'envoi.");
    if (
      !mailbox ||
      (mailbox.is_temp && (!mailbox.expires_at || Date.parse(mailbox.expires_at) <= Date.now()))
    ) {
      throw new Error("Cette adresse d'envoi n'est plus disponible.");
    }
    if (!mailbox.domain?.name) throw new Error("Le domaine de cette adresse n'est pas disponible.");
    if (mailbox.domain.expires_at && Date.parse(mailbox.domain.expires_at) <= Date.now()) {
      throw new Error("Le domaine de cette adresse d'envoi a expiré.");
    }

    const autoBcc = mailbox.auto_bcc ? emailAddress.safeParse(mailbox.auto_bcc.trim()) : null;
    const recipients = deduplicateRecipients(data.to, data.cc, [
      ...data.bcc,
      ...(autoBcc?.success ? [autoBcc.data] : []),
    ]);
    const recipientCount = recipients.to.length + recipients.cc.length + recipients.bcc.length;
    if (recipients.to.length === 0) throw new Error("Ajoutez au moins un destinataire principal.");
    if (recipientCount > recipientLimit) {
      throw new Error(`Un message ne peut pas dépasser ${recipientLimit} destinataires.`);
    }

    const { data: reservation, error: reservationError } = await supabaseAdmin.rpc(
      "reserve_outbound_delivery",
      {
        p_id: data.requestId,
        p_user_id: context.userId,
        p_mailbox_id: mailbox.id,
        p_recipient_count: recipientCount,
      },
    );
    if (reservationError) throw new Error(safeReservationError(reservationError.message));
    if (reservation === "sent") {
      return {
        ok: true,
        duplicate: true,
        archived: true,
        accepted: [] as string[],
        rejected: [] as string[],
      };
    }
    if (reservation === "queued") {
      throw new Error("Cet envoi est déjà en cours de traitement.");
    }
    if (reservation === "failed") {
      throw new Error("Cette tentative a déjà échoué. Relancez un nouvel envoi.");
    }
    if (reservation === "unknown") {
      throw new Error(
        "L’état de remise est incertain. Vérifiez le relais avant de tenter un nouvel envoi.",
      );
    }
    if (reservation !== "reserved") throw new Error("État d'envoi inattendu.");

    const fromAddress = `${mailbox.local_part}@${mailbox.domain.name}`.toLowerCase();
    const fromName = (mailbox.display_name || mailbox.local_part).trim().slice(0, 100);
    const body = signatureBody(data.body, mailbox.signature, mailbox.signature_placement);
    if (Buffer.byteLength(body, "utf8") > 200_000) {
      throw new Error("Le message et sa signature dépassent la taille autorisée.");
    }
    const visibleRecipients = new Set(
      [...data.to, ...data.cc, ...data.bcc].map((address) => address.toLowerCase()),
    );

    try {
      const delivered = await deliverOutboundMessage({
        from: { address: fromAddress, name: fromName },
        to: recipients.to,
        cc: recipients.cc,
        bcc: recipients.bcc,
        subject: data.subject,
        text: body,
        replyTo: fromAddress,
        inReplyTo: data.inReplyTo,
      });
      if (delivered.accepted.length === 0) {
        throw Object.assign(new Error("No recipient accepted"), { code: "EENVELOPE" });
      }

      const { error: completionError } = await supabaseAdmin.rpc("complete_outbound_delivery", {
        p_id: data.requestId,
        p_user_id: context.userId,
        p_status: "sent",
        p_accepted_count: delivered.accepted.length,
        p_rejected_count: delivered.rejected.length,
        p_relay_message_id: delivered.messageId || null,
        p_error_code: delivered.rejected.length ? "PARTIAL_REJECTION" : null,
      });
      if (completionError) {
        console.error("[outbound] sent message audit completion failed", {
          deliveryId: data.requestId,
          code: completionError.code,
        });
      }

      const rejectedRecipients = new Set(
        delivered.rejected.map((address) => address.toLowerCase()),
      );
      const recipientSummary = [...recipients.to, ...recipients.cc]
        .filter((address) => !rejectedRecipients.has(address.toLowerCase()))
        .join(", ")
        .slice(0, 998);
      const senderSummary = `${fromName} <${fromAddress}>`.slice(0, 998);
      const sizeBytes = Buffer.byteLength(
        `${data.subject}\n${body}\n${[...recipients.to, ...recipients.cc, ...recipients.bcc].join(",")}`,
        "utf8",
      );
      const { error: archiveError } = await supabaseAdmin.from("messages").insert({
        mailbox_id: mailbox.id,
        sender: senderSummary,
        recipient_addr: recipientSummary,
        subject: data.subject || null,
        body_text: body,
        folder: "sent",
        seen: true,
        starred: false,
        size_bytes: sizeBytes,
        message_id: delivered.messageId || null,
        in_reply_to: data.inReplyTo || null,
        received_at: new Date().toISOString(),
      });
      if (archiveError) {
        console.error("[outbound] message was sent but could not be archived", {
          deliveryId: data.requestId,
          code: archiveError.code,
        });
      }

      return {
        ok: true,
        duplicate: false,
        archived: !archiveError,
        accepted: delivered.accepted.filter((address) =>
          visibleRecipients.has(address.toLowerCase()),
        ),
        rejected: delivered.rejected.filter((address) =>
          visibleRecipients.has(address.toLowerCase()),
        ),
      };
    } catch (error) {
      const safe = publicOutboundError(error, true);
      const errorRecord =
        error != null && typeof error === "object" ? (error as Record<string, unknown>) : {};
      const accepted = Array.isArray(errorRecord.accepted) ? errorRecord.accepted.length : 0;
      const rejected = Array.isArray(errorRecord.rejected) ? errorRecord.rejected.length : 0;
      const completionStatus = safe.code === "AMBIGUOUS_DELIVERY" ? "unknown" : "failed";
      const { error: completionError } = await supabaseAdmin.rpc("complete_outbound_delivery", {
        p_id: data.requestId,
        p_user_id: context.userId,
        p_status: completionStatus,
        p_accepted_count: accepted,
        p_rejected_count: rejected,
        p_relay_message_id: null,
        p_error_code: safe.code,
      });
      console.error("[outbound] relay delivery failed", {
        deliveryId: data.requestId,
        code: safe.code,
        auditRecorded: !completionError,
      });
      throw new Error(safe.message);
    }
  });
