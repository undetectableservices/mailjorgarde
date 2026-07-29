import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

function boundedEnvInteger(name: string, fallback: number, min: number, max: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

const FIXED_MESSAGE_BYTES = 10 * 1024 * 1024;
const FIXED_BODY_BYTES = 512 * 1024;
const FIXED_RECIPIENTS = 5;
const FIXED_ATTACHMENTS = 32;
const FIXED_ATTACHMENT_BYTES = 8 * 1024 * 1024;

const MAX_MESSAGE_BYTES = boundedEnvInteger(
  "INBOUND_MAX_MESSAGE_BYTES",
  FIXED_MESSAGE_BYTES,
  FIXED_MESSAGE_BYTES,
  FIXED_MESSAGE_BYTES,
);
const MAX_BODY_BYTES = boundedEnvInteger(
  "INBOUND_MAX_BODY_BYTES",
  FIXED_BODY_BYTES,
  FIXED_BODY_BYTES,
  FIXED_BODY_BYTES,
);
const MAX_RECIPIENTS = boundedEnvInteger(
  "INBOUND_MAX_RECIPIENTS",
  FIXED_RECIPIENTS,
  FIXED_RECIPIENTS,
  FIXED_RECIPIENTS,
);
const MAX_ATTACHMENTS = boundedEnvInteger(
  "INBOUND_MAX_ATTACHMENTS",
  FIXED_ATTACHMENTS,
  FIXED_ATTACHMENTS,
  FIXED_ATTACHMENTS,
);
const MAX_ATTACHMENT_BYTES = boundedEnvInteger(
  "INBOUND_MAX_ATTACHMENT_BYTES",
  FIXED_ATTACHMENT_BYTES,
  FIXED_ATTACHMENT_BYTES,
  FIXED_ATTACHMENT_BYTES,
);
// Fixed internal wire contract shared with services/smtp/lib.js. Operator
// limits are validated against it instead of introducing an independently
// tunable request cap that can drift between the two containers.
function deriveWebhookRequestBytes(): number {
  const base64Length = (size: number) => 4 * Math.ceil(size / 3);
  const recipientMetadata = MAX_RECIPIENTS * (254 * 6 + 16);
  const attachmentMetadata = MAX_ATTACHMENTS * ((512 + 255 + 512 + 32 + 128) * 6 + 512);
  return (
    64 * 1024 +
    base64Length(MAX_MESSAGE_BYTES) +
    base64Length(MAX_ATTACHMENT_BYTES) +
    MAX_BODY_BYTES * 12 +
    recipientMetadata +
    attachmentMetadata
  );
}

const MAX_REQUEST_BYTES = deriveWebhookRequestBytes();
const SIGNATURE_MAX_AGE_MS = boundedEnvInteger(
  "INBOUND_SIGNATURE_MAX_AGE_MS",
  5 * 60_000,
  10_000,
  15 * 60_000,
);

const Address = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .email()
  .transform((value) => value.toLowerCase());
const ValidateBody = z
  .object({
    version: z.literal(1),
    action: z.literal("validate"),
    recipient: Address,
  })
  .strict();
const ReadyBody = z
  .object({
    version: z.literal(1),
    action: z.literal("ready"),
  })
  .strict();
const Attachment = z
  .object({
    index: z.number().int().min(0).max(99),
    filename: z.string().min(1).max(512),
    mime: z.string().min(1).max(255),
    size: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES),
    checksum: z
      .string()
      .regex(/^[a-f0-9]{16,128}$/i)
      .optional(),
    content_id: z.string().max(512).optional(),
    content_disposition: z.string().max(32),
    content_base64: z.string().max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4),
  })
  .strict();
const DeliverBody = z
  .object({
    version: z.literal(1),
    action: z.literal("deliver"),
    delivery_id: z.string().regex(/^[a-f0-9]{64}$/),
    recipients: z.array(Address).min(1).max(MAX_RECIPIENTS),
    envelope_from: z.string().max(254),
    header_from: z.string().min(1).max(2048),
    subject: z.string().max(998),
    text: z.string(),
    html: z.string(),
    message_id: z.string().max(998).optional(),
    in_reply_to: z.string().max(998).optional(),
    size_bytes: z.number().int().min(0).max(MAX_MESSAGE_BYTES),
    raw: z
      .object({
        encoding: z.enum(["utf8", "base64"]),
        data: z.string().max(MAX_REQUEST_BYTES),
      })
      .strict(),
    attachments: z.array(Attachment).max(MAX_ATTACHMENTS),
    attachments_truncated: z.boolean(),
  })
  .strict();
const Body = z.discriminatedUnion("action", [ReadyBody, ValidateBody, DeliverBody]);

const inboundLimits = Object.freeze({
  message_bytes: MAX_MESSAGE_BYTES,
  body_bytes: MAX_BODY_BYTES,
  recipients: MAX_RECIPIENTS,
  attachments: MAX_ATTACHMENTS,
  attachment_bytes: MAX_ATTACHMENT_BYTES,
  request_bytes: MAX_REQUEST_BYTES,
});

class RequestTooLargeError extends Error {}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function readBoundedBody(request: Request): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > MAX_REQUEST_BYTES) throw new RequestTooLargeError();
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) throw new RequestTooLargeError();
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof RequestTooLargeError)
      await reader.cancel("request too large").catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

function validTimestamp(value: string | null): value is string {
  if (!value || !/^\d{13}$/.test(value)) return false;
  return Math.abs(Date.now() - Number(value)) <= SIGNATURE_MAX_AGE_MS;
}

function verify(
  signature: string | null,
  timestamp: string,
  body: string,
  secret: string,
): boolean {
  if (!signature) return false;
  const hex = signature.startsWith("v1=") ? signature.slice(3) : signature;
  if (!/^[a-f0-9]{64}$/i.test(hex)) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return timingSafeEqual(Buffer.from(hex, "hex"), Buffer.from(expected, "hex"));
}

function decodeRaw(raw: z.infer<typeof DeliverBody>["raw"]): Buffer | null {
  if (raw.encoding === "utf8") return Buffer.from(raw.data, "utf8");
  return decodeBase64(raw.data);
}

function decodeBase64(value: string): Buffer | null {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    return null;
  return Buffer.from(value, "base64");
}

function deterministicUuid(...parts: string[]): string {
  const bytes = createHash("sha256").update(parts.join("\0")).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function databaseText(value: string): string {
  // PostgreSQL TEXT rejects U+0000. The lossless raw source is always stored
  // as base64, so replacing NUL in convenience/display fields loses no mail.
  return value.replace(/\0/g, "\uFFFD");
}

function isExpired(value: string | null | undefined, now: number): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= now;
}

type RecipientLookup =
  | { accepted: true; recipient: string; mailboxId: string }
  | { accepted: false; reason: "unknown" | "expired" };

type MaterializedAttachmentInsert = Database["public"]["Tables"]["attachments"]["Insert"] & {
  content_base64: string;
  content_disposition: string;
  content_id: string | null;
};

async function lookupRecipient(
  supabaseAdmin: SupabaseClient<Database>,
  recipient: string,
  now: number,
): Promise<RecipientLookup> {
  const at = recipient.lastIndexOf("@");
  const local = recipient.slice(0, at);
  const domain = recipient.slice(at + 1);

  const { data: managedDomain, error: domainError } = await supabaseAdmin
    .from("domains")
    .select("id, expires_at")
    .eq("name", domain)
    .maybeSingle();
  if (domainError) throw new Error(`domain lookup failed: ${domainError.code || "database_error"}`);
  if (!managedDomain) return { accepted: false, reason: "unknown" };
  if (isExpired(managedDomain.expires_at, now)) return { accepted: false, reason: "expired" };

  const { data: mailbox, error: mailboxError } = await supabaseAdmin
    .from("mailboxes")
    .select("id, expires_at")
    .eq("local_part", local)
    .eq("domain_id", managedDomain.id)
    .maybeSingle();
  if (mailboxError)
    throw new Error(`mailbox lookup failed: ${mailboxError.code || "database_error"}`);
  if (!mailbox) return { accepted: false, reason: "unknown" };
  if (isExpired(mailbox.expires_at, now)) return { accepted: false, reason: "expired" };
  return { accepted: true, recipient, mailboxId: mailbox.id };
}

async function handleValidatedRequest(parsed: z.infer<typeof Body>): Promise<Response> {
  let supabaseAdmin: SupabaseClient<Database>;
  try {
    ({ supabaseAdmin } = await import("@/integrations/supabase/client.server"));
  } catch (error) {
    console.error("[inbound] database client unavailable", error);
    return json({ ok: false, code: "database_unavailable" }, 503);
  }
  const now = Date.now();

  if (parsed.action === "ready") {
    try {
      const { error } = await supabaseAdmin
        .from("domains")
        .select("id", { count: "exact", head: true });
      if (error) throw error;
      return json({
        ok: true,
        service: "inbound-ingest",
        version: 1,
        limits: inboundLimits,
      });
    } catch (error) {
      console.error("[inbound] readiness check failed", error);
      return json({ ok: false, code: "database_unavailable" }, 503);
    }
  }

  if (parsed.action === "validate") {
    try {
      const result = await lookupRecipient(supabaseAdmin, parsed.recipient, now);
      if (!result.accepted) {
        return json(
          {
            ok: false,
            code: result.reason === "expired" ? "recipient_expired" : "unknown_recipient",
          },
          result.reason === "expired" ? 410 : 404,
        );
      }
      return json({ ok: true, canonical_recipient: result.recipient });
    } catch (error) {
      console.error("[inbound] recipient validation failed", error);
      return json({ ok: false, code: "temporary_failure" }, 503);
    }
  }

  const recipients = [...new Set(parsed.recipients)].sort();
  const rawBytes = decodeRaw(parsed.raw);
  if (!rawBytes || rawBytes.length !== parsed.size_bytes || rawBytes.length > MAX_MESSAGE_BYTES) {
    return json({ ok: false, code: "invalid_raw_message" }, 400);
  }
  if (
    Buffer.byteLength(parsed.text, "utf8") > MAX_BODY_BYTES ||
    Buffer.byteLength(parsed.html, "utf8") > MAX_BODY_BYTES
  ) {
    return json({ ok: false, code: "parsed_body_too_large" }, 413);
  }
  let totalAttachmentBytes = 0;
  for (const attachment of parsed.attachments) {
    const content = decodeBase64(attachment.content_base64);
    if (!content || content.length !== attachment.size) {
      return json({ ok: false, code: "invalid_attachment_content" }, 400);
    }
    totalAttachmentBytes += content.length;
    if (content.length > MAX_ATTACHMENT_BYTES || totalAttachmentBytes > MAX_ATTACHMENT_BYTES) {
      return json({ ok: false, code: "attachment_content_too_large" }, 413);
    }
  }

  let lookups: RecipientLookup[];
  try {
    lookups = await Promise.all(
      recipients.map((recipient) => lookupRecipient(supabaseAdmin, recipient, now)),
    );
  } catch (error) {
    console.error("[inbound] delivery recipient lookup failed", error);
    return json({ ok: false, code: "temporary_failure" }, 503);
  }
  const unavailable = lookups.find((lookup) => !lookup.accepted);
  if (unavailable && !unavailable.accepted) {
    return json(
      {
        ok: false,
        code: unavailable.reason === "expired" ? "recipient_expired" : "unknown_recipient",
      },
      unavailable.reason === "expired" ? 410 : 404,
    );
  }

  const accepted = lookups.filter(
    (lookup): lookup is Extract<RecipientLookup, { accepted: true }> => lookup.accepted,
  );
  const storedRaw = `base64:${rawBytes.toString("base64")}`;
  const messageRows = accepted.map((lookup) => {
    const id = deterministicUuid(
      "jorgarde-inbound-message-v1",
      parsed.delivery_id,
      lookup.mailboxId,
    );
    return {
      id,
      mailbox_id: lookup.mailboxId,
      sender: databaseText(parsed.header_from),
      recipient_addr: databaseText(lookup.recipient),
      subject: parsed.subject ? databaseText(parsed.subject) : null,
      body_text: parsed.text ? databaseText(parsed.text) : null,
      body_html: parsed.html ? databaseText(parsed.html) : null,
      raw: storedRaw,
      message_id: parsed.message_id ? databaseText(parsed.message_id) : null,
      in_reply_to: parsed.in_reply_to ? databaseText(parsed.in_reply_to) : null,
      size_bytes: rawBytes.length,
    };
  });

  const attachmentRows: MaterializedAttachmentInsert[] = messageRows.flatMap((message) =>
    parsed.attachments.map((attachment) => {
      const id = deterministicUuid(
        "jorgarde-inbound-attachment-v1",
        message.id,
        String(attachment.index),
      );
      return {
        id,
        message_id: message.id,
        filename: databaseText(attachment.filename),
        mime: databaseText(attachment.mime),
        size: attachment.size,
        storage_path: `inline-db://${id}`,
        content_base64: attachment.content_base64,
        content_disposition: databaseText(attachment.content_disposition),
        content_id: attachment.content_id ? databaseText(attachment.content_id) : null,
      };
    }),
  );

  const { data: persistence, error: persistenceError } = await supabaseAdmin.rpc(
    "store_inbound_delivery",
    {
      p_messages: messageRows,
      p_attachments: attachmentRows,
    },
  );
  if (persistenceError) {
    console.error("[inbound] atomic delivery persistence failed", {
      code: persistenceError.code,
    });
    if (persistenceError.code === "P5501") {
      return json({ ok: false, code: "storage_quota_exceeded" }, 413);
    }
    const recipientGone = persistenceError.code === "23503";
    return json(
      { ok: false, code: recipientGone ? "unknown_recipient" : "temporary_failure" },
      recipientGone ? 404 : 503,
    );
  }
  const result = Array.isArray(persistence) ? persistence[0] : null;
  if (
    !result ||
    !Number.isInteger(result.messages) ||
    result.messages < 0 ||
    !Number.isInteger(result.attachments) ||
    result.attachments < 0
  ) {
    console.error("[inbound] atomic delivery RPC returned an invalid result");
    return json({ ok: false, code: "temporary_failure" }, 503);
  }

  return json({
    ok: true,
    delivery_id: parsed.delivery_id,
    recipients: accepted.length,
    attachments: parsed.attachments.length,
    attachments_truncated: parsed.attachments_truncated,
  });
}

export const Route = createFileRoute("/api/public/inbound")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = (process.env.INBOUND_WEBHOOK_SECRET || "").trim();
        if (secret.length < 32) {
          console.error(
            "[inbound] refusing request: INBOUND_WEBHOOK_SECRET is missing or too short",
          );
          return json({ ok: false, code: "not_configured" }, 503);
        }

        const timestamp = request.headers.get("x-inbound-timestamp");
        const signature = request.headers.get("x-inbound-signature");
        if (!validTimestamp(timestamp) || !signature || !/^v1=[a-f0-9]{64}$/i.test(signature)) {
          return json({ ok: false, code: "invalid_signature" }, 401);
        }

        let rawBody: string;
        try {
          rawBody = await readBoundedBody(request);
        } catch (error) {
          if (error instanceof RequestTooLargeError)
            return json({ ok: false, code: "request_too_large" }, 413);
          console.error("[inbound] request body read failed", error);
          return json({ ok: false, code: "temporary_failure" }, 503);
        }
        if (!verify(signature, timestamp, rawBody, secret)) {
          return json({ ok: false, code: "invalid_signature" }, 401);
        }

        let parsed: z.infer<typeof Body>;
        try {
          parsed = Body.parse(JSON.parse(rawBody));
        } catch {
          return json({ ok: false, code: "invalid_payload" }, 400);
        }
        return handleValidatedRequest(parsed);
      },
    },
  },
});
