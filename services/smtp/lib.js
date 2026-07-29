import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const FROZEN_INBOUND_LIMITS = Object.freeze({
  maxMessageBytes: 10 * 1024 * 1024,
  maxBodyBytes: 512 * 1024,
  maxRecipients: 5,
  maxAttachments: 32,
  maxAttachmentBytes: 8 * 1024 * 1024,
  maxDeliveryConcurrency: 2,
});

export function readBoundedInteger(value, fallback, { min, max, name = "value" }) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

export function normalizeMailbox(value) {
  if (typeof value !== "string") return null;
  const address = value.trim().toLowerCase();
  if (address.length < 3 || address.length > 254 || !/^[\x21-\x7e]+$/.test(address)) return null;

  const at = address.lastIndexOf("@");
  if (at < 1 || at !== address.indexOf("@")) return null;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (local.length > 64 || domain.length < 1 || domain.length > 253) return null;
  if (!/^[a-z0-9][a-z0-9._+-]*[a-z0-9]$|^[a-z0-9]$/.test(local)) return null;
  if (
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      domain,
    )
  )
    return null;
  return address;
}

export function normalizeEnvelopeSender(value) {
  if (typeof value !== "string") return null;
  const address = value.trim();
  if (
    address.length < 3 ||
    Buffer.byteLength(address, "ascii") > 254 ||
    !/^[\x20-\x7e]+$/.test(address) ||
    /[\r\n\0]/.test(address)
  )
    return null;

  // smtp-server has already parsed RFC 5321 mailbox syntax before invoking
  // onMailFrom. Keep this check deliberately permissive so valid quoted local
  // parts, address literals and VERP characters such as '=' are not rejected.
  const at = address.lastIndexOf("@");
  if (at < 1 || at === address.length - 1) return null;
  return address;
}

export function signWebhookBody(secret, timestamp, body) {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function verifyWebhookSignature(secret, timestamp, body, signature) {
  if (typeof signature !== "string") return false;
  const hex = signature.startsWith("v1=") ? signature.slice(3) : signature;
  if (!/^[a-f0-9]{64}$/i.test(hex)) return false;
  const expected = signWebhookBody(secret, timestamp, body);
  return timingSafeEqual(Buffer.from(hex, "hex"), Buffer.from(expected, "hex"));
}

export function createDeliveryId() {
  // A delivery ID identifies one SMTP transaction, not message content.
  // Content-addressed IDs silently collapse legitimate identical messages.
  return randomBytes(32).toString("hex");
}

export function deriveWebhookRequestBytes({
  maxMessageBytes,
  maxBodyBytes,
  maxRecipients,
  maxAttachments,
  maxAttachmentBytes,
}) {
  const base64Length = (size) => 4 * Math.ceil(size / 3);
  const recipientMetadata = maxRecipients * (254 * 6 + 16);
  const attachmentMetadata = maxAttachments * ((512 + 255 + 512 + 32 + 128) * 6 + 512);

  return (
    64 * 1024 +
    base64Length(maxMessageBytes) +
    base64Length(maxAttachmentBytes) +
    maxBodyBytes * 12 +
    recipientMetadata +
    attachmentMetadata
  );
}

// Fixed internal protocol limit derived from the only supported deployment
// limits. It is intentionally not an independent environment setting.
export const MAX_SIGNED_WEBHOOK_BYTES = deriveWebhookRequestBytes(FROZEN_INBOUND_LIMITS);

export function deterministicUuid(...parts) {
  const bytes = createHash("sha256").update(parts.join("\0")).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function encodeRawMessage(raw) {
  // Base64 keeps the signed HTTP payload size predictable and preserves
  // arbitrary 8BITMIME octets without JSON/UTF-8 replacement.
  return { encoding: "base64", data: raw.toString("base64") };
}

export function truncateUtf8(value, maxBytes) {
  const text = typeof value === "string" ? value : "";
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  return bytes
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
}

export class FixedWindowLimiter {
  #entries = new Map();

  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  consume(key, now = Date.now()) {
    const existing = this.#entries.get(key);
    if (!existing || now - existing.startedAt >= this.windowMs) {
      this.#entries.set(key, { count: 1, startedAt: now });
      return true;
    }
    if (existing.count >= this.limit) return false;
    existing.count += 1;
    return true;
  }

  prune(now = Date.now()) {
    for (const [key, entry] of this.#entries) {
      if (now - entry.startedAt >= this.windowMs * 2) this.#entries.delete(key);
    }
  }
}

export function smtpError(responseCode, message) {
  const error = new Error(message);
  error.responseCode = responseCode;
  return error;
}
