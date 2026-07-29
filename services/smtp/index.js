// Internet-facing, inbound-only SMTP edge. It validates every recipient with
// the application before DATA, then acknowledges DATA only after the complete
// message has been durably accepted by the application.

import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import { createServer as createHttpServer } from "node:http";
import { readFileSync } from "node:fs";
import { createHash, X509Certificate } from "node:crypto";
import { createSecureContext } from "node:tls";
import {
  FixedWindowLimiter,
  FROZEN_INBOUND_LIMITS,
  MAX_SIGNED_WEBHOOK_BYTES,
  createDeliveryId,
  deriveWebhookRequestBytes,
  encodeRawMessage,
  normalizeEnvelopeSender,
  normalizeMailbox,
  readBoundedInteger,
  signWebhookBody,
  smtpError,
  truncateUtf8,
} from "./lib.js";

const WEBHOOK_URL = process.env.WEBHOOK_URL || "http://web:6969/api/public/inbound";
const SECRET = (process.env.INBOUND_WEBHOOK_SECRET || "").trim();
const HOSTNAME = (process.env.SMTP_HOSTNAME || "localhost").trim();
const SMTP_PORT = readBoundedInteger(process.env.SMTP_PORT, 2525, {
  min: 1,
  max: 65535,
  name: "SMTP_PORT",
});
const HEALTH_PORT = readBoundedInteger(process.env.HEALTH_PORT, 8080, {
  min: 1,
  max: 65535,
  name: "HEALTH_PORT",
});
const MAX_MESSAGE_BYTES = readBoundedInteger(
  process.env.MAX_MESSAGE_BYTES,
  FROZEN_INBOUND_LIMITS.maxMessageBytes,
  {
    min: FROZEN_INBOUND_LIMITS.maxMessageBytes,
    max: FROZEN_INBOUND_LIMITS.maxMessageBytes,
    name: "MAX_MESSAGE_BYTES",
  },
);
const MAX_BODY_BYTES = readBoundedInteger(
  process.env.MAX_BODY_BYTES,
  FROZEN_INBOUND_LIMITS.maxBodyBytes,
  {
    min: FROZEN_INBOUND_LIMITS.maxBodyBytes,
    max: FROZEN_INBOUND_LIMITS.maxBodyBytes,
    name: "MAX_BODY_BYTES",
  },
);
const MAX_RECIPIENTS = readBoundedInteger(
  process.env.MAX_RECIPIENTS,
  FROZEN_INBOUND_LIMITS.maxRecipients,
  {
    min: FROZEN_INBOUND_LIMITS.maxRecipients,
    max: FROZEN_INBOUND_LIMITS.maxRecipients,
    name: "MAX_RECIPIENTS",
  },
);
const MAX_RECIPIENT_ATTEMPTS = readBoundedInteger(
  process.env.MAX_RECIPIENT_ATTEMPTS,
  Math.max(40, MAX_RECIPIENTS * 3),
  {
    min: MAX_RECIPIENTS,
    max: 1000,
    name: "MAX_RECIPIENT_ATTEMPTS",
  },
);
const MAX_ATTACHMENTS = readBoundedInteger(
  process.env.MAX_ATTACHMENTS,
  FROZEN_INBOUND_LIMITS.maxAttachments,
  {
    min: FROZEN_INBOUND_LIMITS.maxAttachments,
    max: FROZEN_INBOUND_LIMITS.maxAttachments,
    name: "MAX_ATTACHMENTS",
  },
);
const MAX_ATTACHMENT_BYTES = readBoundedInteger(
  process.env.MAX_ATTACHMENT_BYTES,
  FROZEN_INBOUND_LIMITS.maxAttachmentBytes,
  {
    min: FROZEN_INBOUND_LIMITS.maxAttachmentBytes,
    max: FROZEN_INBOUND_LIMITS.maxAttachmentBytes,
    name: "MAX_ATTACHMENT_BYTES",
  },
);
const MAX_CONNECTIONS = readBoundedInteger(process.env.MAX_CONNECTIONS, 50, {
  min: 1,
  max: 500,
  name: "MAX_CONNECTIONS",
});
const MAX_CONNECTIONS_PER_IP = readBoundedInteger(process.env.MAX_CONNECTIONS_PER_IP, 5, {
  min: 1,
  max: 50,
  name: "MAX_CONNECTIONS_PER_IP",
});
const CONNECTIONS_PER_MINUTE = readBoundedInteger(process.env.CONNECTIONS_PER_MINUTE, 30, {
  min: 1,
  max: 1000,
  name: "CONNECTIONS_PER_MINUTE",
});
const MESSAGES_PER_MINUTE = readBoundedInteger(process.env.MESSAGES_PER_MINUTE, 20, {
  min: 1,
  max: 1000,
  name: "MESSAGES_PER_MINUTE",
});
const RECIPIENT_ATTEMPTS_PER_MINUTE = readBoundedInteger(
  process.env.RECIPIENT_ATTEMPTS_PER_MINUTE,
  300,
  {
    min: 10,
    max: 10_000,
    name: "RECIPIENT_ATTEMPTS_PER_MINUTE",
  },
);
const MAX_DELIVERY_CONCURRENCY = readBoundedInteger(
  process.env.MAX_DELIVERY_CONCURRENCY,
  FROZEN_INBOUND_LIMITS.maxDeliveryConcurrency,
  {
    min: FROZEN_INBOUND_LIMITS.maxDeliveryConcurrency,
    max: FROZEN_INBOUND_LIMITS.maxDeliveryConcurrency,
    name: "MAX_DELIVERY_CONCURRENCY",
  },
);
const VALIDATION_TIMEOUT_MS = readBoundedInteger(process.env.VALIDATION_TIMEOUT_MS, 5000, {
  min: 500,
  max: 30000,
  name: "VALIDATION_TIMEOUT_MS",
});
const DELIVERY_TIMEOUT_MS = readBoundedInteger(process.env.DELIVERY_TIMEOUT_MS, 30000, {
  min: 1000,
  max: 120000,
  name: "DELIVERY_TIMEOUT_MS",
});
const TLS_RELOAD_INTERVAL_MS = readBoundedInteger(process.env.TLS_RELOAD_INTERVAL_MS, 30_000, {
  min: 5_000,
  max: 10 * 60_000,
  name: "TLS_RELOAD_INTERVAL_MS",
});

if (SECRET.length < 32)
  throw new Error("INBOUND_WEBHOOK_SECRET is required and must contain at least 32 characters");
if (!HOSTNAME || /\s/.test(HOSTNAME)) throw new Error("SMTP_HOSTNAME must be a valid hostname");
const webhook = new URL(WEBHOOK_URL);
if (!/^https?:$/.test(webhook.protocol))
  throw new Error("WEBHOOK_URL must use http:// or https://");

const requiredWebhookBytes = deriveWebhookRequestBytes({
  maxMessageBytes: MAX_MESSAGE_BYTES,
  maxBodyBytes: MAX_BODY_BYTES,
  maxRecipients: MAX_RECIPIENTS,
  maxAttachments: MAX_ATTACHMENTS,
  maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
});
if (requiredWebhookBytes > MAX_SIGNED_WEBHOOK_BYTES) {
  throw new Error(
    `SMTP limits require ${requiredWebhookBytes} webhook bytes, above the fixed ${MAX_SIGNED_WEBHOOK_BYTES} byte protocol limit`,
  );
}

const TLS_CERT = process.env.TLS_CERT;
const TLS_KEY = process.env.TLS_KEY;
const TLS_REQUIRED = /^(?:1|true|yes)$/i.test(process.env.SMTP_REQUIRE_TLS_CERT || "");

function readTlsMaterial() {
  if (!TLS_CERT || !TLS_KEY) {
    return { options: null, status: "missing", reason: "TLS certificate paths are not configured" };
  }
  try {
    const cert = readFileSync(TLS_CERT);
    const key = readFileSync(TLS_KEY);
    const x509 = new X509Certificate(cert);
    const validFrom = Date.parse(x509.validFrom);
    const validTo = Date.parse(x509.validTo);
    const now = Date.now();
    if (!Number.isFinite(validFrom) || !Number.isFinite(validTo)) {
      return { options: null, status: "invalid", reason: "certificate validity is unreadable" };
    }
    if (now < validFrom) {
      return {
        options: null,
        status: "not_yet_valid",
        reason: `certificate valid from ${x509.validFrom}`,
      };
    }
    if (now >= validTo) {
      return { options: null, status: "expired", reason: `certificate expired at ${x509.validTo}` };
    }

    // Validate that OpenSSL can load the key/certificate pair before exposing
    // STARTTLS. updateSecureContext performs the same validation on reload.
    createSecureContext({ cert, key });
    return {
      options: { cert, key },
      status: "ready",
      reason: null,
      notAfter: new Date(validTo).toISOString(),
      version: createHash("sha256").update(cert).update(key).digest("hex"),
    };
  } catch (error) {
    const missing = error && typeof error === "object" && error.code === "ENOENT";
    return {
      options: null,
      status: missing ? "missing" : "invalid",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
let tlsMaterial = readTlsMaterial();
if (!tlsMaterial.options) {
  console.warn(`[smtp] ${tlsMaterial.reason}; STARTTLS is disabled on port 25`);
}

const SESSION_ACCEPTED = Symbol("accepted-connection");
const SESSION_RECIPIENTS = Symbol("validated-recipients");
const SESSION_RECIPIENT_CACHE = Symbol("recipient-validation-cache");
const SESSION_RECIPIENT_ATTEMPTS = Symbol("recipient-attempts");
const SESSION_DELIVERY_ID = Symbol("delivery-id");
const connectionRate = new FixedWindowLimiter(CONNECTIONS_PER_MINUTE, 60_000);
const messageRate = new FixedWindowLimiter(MESSAGES_PER_MINUTE, 60_000);
const recipientRate = new FixedWindowLimiter(RECIPIENT_ATTEMPTS_PER_MINUTE, 60_000);
const activeByIp = new Map();
const metrics = {
  startedAt: new Date().toISOString(),
  activeConnections: 0,
  activeDeliveries: 0,
  acceptedMessages: 0,
  temporaryFailures: 0,
  rejectedRecipients: 0,
  starttls: Boolean(tlsMaterial.options),
  tlsRequired: TLS_REQUIRED,
  tlsStatus: tlsMaterial.status,
  tlsNotAfter: tlsMaterial.notAfter || null,
};

const cleanupTimer = setInterval(() => {
  connectionRate.prune();
  messageRate.prune();
  recipientRate.prune();
}, 60_000);
cleanupTimer.unref();

class WebhookError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const WEBHOOK_RESPONSE_BYTES = 8192;
const expectedInboundLimits = Object.freeze({
  message_bytes: MAX_MESSAGE_BYTES,
  body_bytes: MAX_BODY_BYTES,
  recipients: MAX_RECIPIENTS,
  attachments: MAX_ATTACHMENTS,
  attachment_bytes: MAX_ATTACHMENT_BYTES,
  request_bytes: MAX_SIGNED_WEBHOOK_BYTES,
});

async function readBoundedResponseJson(response) {
  if (!response.body) return { value: null, tooLarge: false };
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > WEBHOOK_RESPONSE_BYTES) {
        await reader.cancel("response too large").catch(() => {});
        return { value: null, tooLarge: true };
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  if (size === 0) return { value: null, tooLarge: false };
  try {
    const value = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
    return {
      value: value && typeof value === "object" && !Array.isArray(value) ? value : null,
      tooLarge: false,
    };
  } catch {
    return { value: null, tooLarge: false };
  }
}

function webhookFailureReason(error) {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
    ? "timeout"
    : "connection_failed";
}

async function signedWebhookRequest(payload, timeoutMs) {
  const body = JSON.stringify({ version: 1, ...payload });
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes > MAX_SIGNED_WEBHOOK_BYTES) {
    throw new WebhookError(413, "request_too_large", "signed inbound request is too large");
  }
  const timestamp = String(Date.now());
  let response;
  try {
    response = await fetch(webhook, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(bodyBytes),
        "x-inbound-timestamp": timestamp,
        "x-inbound-signature": `v1=${signWebhookBody(SECRET, timestamp, body)}`,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch (error) {
    const reason = webhookFailureReason(error);
    throw new WebhookError(503, reason, `inbound API ${reason}`);
  }

  let parsed;
  try {
    parsed = await readBoundedResponseJson(response);
  } catch {
    parsed = { value: null, tooLarge: false };
  }
  if (!response.ok) {
    throw new WebhookError(
      response.status,
      typeof parsed.value?.code === "string" ? parsed.value.code : "request_failed",
      `inbound API returned ${response.status}`,
    );
  }
  if (parsed.tooLarge || !parsed.value || parsed.value.ok !== true) {
    throw new WebhookError(
      503,
      "invalid_response",
      "inbound API returned an invalid success response",
    );
  }
  return parsed.value;
}

function inboundContractMatches(result) {
  if (
    !result ||
    result.ok !== true ||
    result.service !== "inbound-ingest" ||
    result.version !== 1 ||
    !result.limits ||
    typeof result.limits !== "object"
  )
    return false;
  return Object.entries(expectedInboundLimits).every(
    ([key, value]) => result.limits[key] === value,
  );
}

async function probeInboundContract() {
  const result = await signedWebhookRequest({ action: "ready" }, VALIDATION_TIMEOUT_MS);
  if (!inboundContractMatches(result)) {
    throw new WebhookError(
      503,
      "contract_mismatch",
      "inbound API limit contract does not match SMTP",
    );
  }
  return result;
}

function remoteIp(session) {
  return session.remoteAddress || "unknown";
}

function drainAndReject(stream, callback, error) {
  let completed = false;
  const reject = () => {
    if (completed) return;
    completed = true;
    callback(error);
  };
  stream.on("error", reject);
  stream.on("end", reject);
  stream.resume();
}

async function readRawMessage(stream) {
  const chunks = [];
  let size = 0;
  let exceeded = false;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size <= MAX_MESSAGE_BYTES) chunks.push(buffer);
    else exceeded = true;
  }
  if (stream.sizeExceeded || exceeded)
    throw smtpError(552, "5.3.4 Message exceeds fixed maximum message size");
  return Buffer.concat(chunks, size);
}

function boundedHeader(value, maxBytes = 2048) {
  return truncateUtf8(typeof value === "string" ? value : "", maxBytes)
    .replace(/[\0\r\n]+/g, " ")
    .trim();
}

function boundedDatabaseText(value, maxBytes) {
  return truncateUtf8(typeof value === "string" ? value : "", maxBytes).replace(/\0/g, "\uFFFD");
}

async function parseMessage(raw, session) {
  let parsed;
  try {
    parsed = await simpleParser(raw, {
      skipHtmlToText: true,
      skipTextToHtml: true,
      skipImageLinks: true,
      maxHtmlLengthToParse: MAX_BODY_BYTES,
    });
  } catch (error) {
    console.warn(
      "[smtp] MIME parsing failed; preserving raw message",
      error instanceof Error ? error.message : error,
    );
    parsed = {};
  }

  if (Array.isArray(parsed.attachments) && parsed.attachments.length > MAX_ATTACHMENTS) {
    throw smtpError(552, "5.3.4 Message contains too many attachments");
  }

  const envelopeFrom = boundedHeader(session.envelope.mailFrom?.address || "", 254);
  let totalAttachmentBytes = 0;
  const attachments = Array.isArray(parsed.attachments)
    ? parsed.attachments.map((attachment, index) => {
        const content = Buffer.isBuffer(attachment.content)
          ? attachment.content
          : Buffer.from(attachment.content || "");
        totalAttachmentBytes += content.length;
        if (content.length > MAX_ATTACHMENT_BYTES || totalAttachmentBytes > MAX_ATTACHMENT_BYTES) {
          throw smtpError(552, "5.3.4 Attachment exceeds fixed maximum size");
        }
        return {
          index,
          filename: boundedHeader(attachment.filename || `attachment-${index + 1}`, 512),
          mime: boundedHeader(attachment.contentType || "application/octet-stream", 255),
          size: content.length,
          checksum:
            typeof attachment.checksum === "string" ? attachment.checksum.toLowerCase() : undefined,
          content_id: boundedHeader(attachment.contentId || "", 512) || undefined,
          content_disposition: boundedHeader(attachment.contentDisposition || "attachment", 32),
          content_base64: content.toString("base64"),
        };
      })
    : [];

  return {
    envelope_from: envelopeFrom,
    header_from: boundedHeader(parsed.from?.text || envelopeFrom || "<>"),
    subject: boundedDatabaseText(parsed.subject, 998),
    text: boundedDatabaseText(parsed.text, MAX_BODY_BYTES),
    html: boundedDatabaseText(parsed.html, MAX_BODY_BYTES),
    message_id: boundedHeader(parsed.messageId || "", 998) || undefined,
    in_reply_to: boundedHeader(parsed.inReplyTo || "", 998) || undefined,
    attachments,
    attachments_truncated: false,
  };
}

function resetTransactionState(session) {
  session[SESSION_RECIPIENTS] = new Map();
  session[SESSION_RECIPIENT_CACHE] = new Map();
  session[SESSION_RECIPIENT_ATTEMPTS] = 0;
  session[SESSION_DELIVERY_ID] = createDeliveryId();
}

function onConnect(session, callback) {
  const ip = remoteIp(session);
  const activeForIp = activeByIp.get(ip) || 0;
  if (metrics.activeConnections >= MAX_CONNECTIONS || activeForIp >= MAX_CONNECTIONS_PER_IP) {
    return callback(smtpError(421, "4.3.2 Too many concurrent connections"));
  }
  if (!connectionRate.consume(ip))
    return callback(smtpError(421, "4.7.0 Connection rate limit exceeded"));

  session[SESSION_ACCEPTED] = true;
  resetTransactionState(session);
  activeByIp.set(ip, activeForIp + 1);
  metrics.activeConnections += 1;
  callback();
}

function onClose(session) {
  if (!session[SESSION_ACCEPTED]) return;
  session[SESSION_ACCEPTED] = false;
  const ip = remoteIp(session);
  const remaining = Math.max(0, (activeByIp.get(ip) || 1) - 1);
  if (remaining === 0) activeByIp.delete(ip);
  else activeByIp.set(ip, remaining);
  metrics.activeConnections = Math.max(0, metrics.activeConnections - 1);
}

function onMailFrom(address, session, callback) {
  // A null reverse-path is required for delivery-status notifications.
  if (address.address && !normalizeEnvelopeSender(address.address)) {
    return callback(smtpError(553, "5.1.7 Unsupported envelope sender address"));
  }
  resetTransactionState(session);
  callback();
}

async function onRcptTo(address, session, callback) {
  session[SESSION_RECIPIENT_ATTEMPTS] = (session[SESSION_RECIPIENT_ATTEMPTS] || 0) + 1;
  if (session[SESSION_RECIPIENT_ATTEMPTS] > MAX_RECIPIENT_ATTEMPTS) {
    return callback(smtpError(452, "4.5.3 Too many recipient attempts"));
  }
  if (!recipientRate.consume(remoteIp(session))) {
    return callback(smtpError(451, "4.7.1 Recipient validation rate limit exceeded"));
  }

  const recipient = normalizeMailbox(address.address);
  if (!recipient) return callback(smtpError(553, "5.1.3 Invalid recipient address"));
  const recipients = session[SESSION_RECIPIENTS] || new Map();
  const cache = session[SESSION_RECIPIENT_CACHE] || new Map();
  session[SESSION_RECIPIENTS] = recipients;
  session[SESSION_RECIPIENT_CACHE] = cache;
  if (!recipients.has(recipient) && recipients.size >= MAX_RECIPIENTS) {
    return callback(smtpError(452, "4.5.3 Too many recipients"));
  }
  if (cache.has(recipient)) {
    const cached = cache.get(recipient);
    return cached ? callback() : callback(smtpError(550, "5.1.1 Mailbox unavailable"));
  }

  try {
    const result = await signedWebhookRequest(
      { action: "validate", recipient },
      VALIDATION_TIMEOUT_MS,
    );
    const canonical = normalizeMailbox(result.canonical_recipient);
    if (!canonical || result.canonical_recipient !== canonical)
      throw new WebhookError(503, "invalid_response", "inbound API returned an invalid recipient");
    recipients.set(recipient, canonical);
    cache.set(recipient, canonical);
    callback();
  } catch (error) {
    if (error instanceof WebhookError && (error.status === 404 || error.status === 410)) {
      metrics.rejectedRecipients += 1;
      cache.set(recipient, null);
      return callback(smtpError(550, "5.1.1 Mailbox unavailable"));
    }
    metrics.temporaryFailures += 1;
    console.error(
      "[smtp] recipient validation unavailable",
      error instanceof Error ? error.message : error,
    );
    callback(smtpError(451, "4.3.0 Temporary recipient validation failure"));
  }
}

function onData(stream, session, callback) {
  const ip = remoteIp(session);
  if (!messageRate.consume(ip)) {
    return drainAndReject(stream, callback, smtpError(451, "4.7.1 Message rate limit exceeded"));
  }
  if (metrics.activeDeliveries >= MAX_DELIVERY_CONCURRENCY) {
    return drainAndReject(stream, callback, smtpError(451, "4.3.2 Server temporarily busy"));
  }

  metrics.activeDeliveries += 1;
  void (async () => {
    try {
      const raw = await readRawMessage(stream);
      const mappedRecipients = session.envelope.rcptTo.map((address) => {
        const requested = normalizeMailbox(address.address);
        return requested ? session[SESSION_RECIPIENTS]?.get(requested) : null;
      });
      if (mappedRecipients.some((recipient) => !recipient)) {
        throw smtpError(554, "5.5.1 Recipient was not validated for this transaction");
      }
      const recipients = [...new Set(mappedRecipients)].sort();
      if (recipients.length === 0) throw smtpError(554, "5.5.1 No valid recipients");

      const parsed = await parseMessage(raw, session);
      const deliveryId = session[SESSION_DELIVERY_ID];
      if (typeof deliveryId !== "string" || !/^[a-f0-9]{64}$/.test(deliveryId)) {
        throw new WebhookError(503, "invalid_transaction", "SMTP transaction has no delivery ID");
      }
      const result = await signedWebhookRequest(
        {
          action: "deliver",
          delivery_id: deliveryId,
          recipients,
          size_bytes: raw.length,
          raw: encodeRawMessage(raw),
          ...parsed,
        },
        DELIVERY_TIMEOUT_MS,
      );
      if (
        result.delivery_id !== deliveryId ||
        result.recipients !== recipients.length ||
        result.attachments !== parsed.attachments.length
      ) {
        throw new WebhookError(
          503,
          "invalid_response",
          "inbound API did not confirm this delivery",
        );
      }
      metrics.acceptedMessages += 1;
      callback();
    } catch (error) {
      if (error?.responseCode) return callback(error);
      if (error instanceof WebhookError && (error.status === 404 || error.status === 410)) {
        return callback(smtpError(550, "5.1.1 Recipient became unavailable"));
      }
      if (error instanceof WebhookError && error.status === 413) {
        if (error.code === "storage_quota_exceeded") {
          return callback(smtpError(552, "5.2.2 Mailbox storage quota exceeded"));
        }
        return callback(smtpError(552, "5.3.4 Message exceeds fixed maximum message size"));
      }
      metrics.temporaryFailures += 1;
      console.error("[smtp] persistence failed", error instanceof Error ? error.message : error);
      callback(smtpError(451, "4.3.0 Temporary persistence failure; please retry"));
    } finally {
      metrics.activeDeliveries = Math.max(0, metrics.activeDeliveries - 1);
    }
  })();
}

const smtp = new SMTPServer({
  name: HOSTNAME,
  banner: "JorgardeMail inbound mail",
  secure: false,
  disabledCommands: ["AUTH"],
  hideSTARTTLS: !tlsMaterial.options,
  hideSMTPUTF8: true,
  size: MAX_MESSAGE_BYTES,
  maxClients: MAX_CONNECTIONS,
  socketTimeout: 60_000,
  closeTimeout: 30_000,
  onConnect,
  onClose,
  onMailFrom,
  onRcptTo,
  onData,
  ...(tlsMaterial.options || {}),
});

let smtpListening = false;
smtp.on("error", (error) => {
  smtpListening = false;
  console.error("[smtp] server error", error);
  setImmediate(() => process.exit(1));
});

let tlsVersion = tlsMaterial.version || null;
function setTlsMetrics(material) {
  metrics.starttls = Boolean(material.options);
  metrics.tlsStatus = material.status;
  metrics.tlsNotAfter = material.notAfter || null;
}

function reloadTlsMaterial() {
  const next = readTlsMaterial();
  if (!next.options) {
    const changed = metrics.starttls || metrics.tlsStatus !== next.status;
    smtp.options.hideSTARTTLS = true;
    tlsVersion = null;
    tlsMaterial = next;
    setTlsMetrics(next);
    if (changed) console.error(`[smtp] ${next.reason}; STARTTLS disabled`);
    return;
  }
  if (next.version !== tlsVersion) {
    smtp.updateSecureContext(next.options);
    console.log("[smtp] TLS certificate loaded/reloaded; STARTTLS enabled");
  }
  smtp.options.hideSTARTTLS = false;
  tlsVersion = next.version;
  tlsMaterial = next;
  setTlsMetrics(next);
}

const tlsReloadTimer =
  TLS_CERT && TLS_KEY
    ? setInterval(() => {
        try {
          reloadTlsMaterial();
        } catch (error) {
          smtp.options.hideSTARTTLS = true;
          metrics.starttls = false;
          metrics.tlsStatus = "invalid";
          metrics.tlsNotAfter = null;
          console.error("[smtp] TLS certificate reload failed", error);
        }
      }, TLS_RELOAD_INTERVAL_MS)
    : null;
tlsReloadTimer?.unref();

// Refuse to open the MX listener until the signed API proves that its secret
// and all resource limits match this process. Docker restarts us while the web
// service is unavailable; it is safer than accepting DATA into a split config.
await probeInboundContract();
smtp.listen(SMTP_PORT, "0.0.0.0", () => {
  smtpListening = true;
  console.log(`[smtp] inbound SMTP ready on :${SMTP_PORT}`);
});

const health = createHttpServer(async (request, response) => {
  if (request.method !== "GET" || (request.url !== "/healthz" && request.url !== "/readyz")) {
    response.writeHead(404).end("not found\n");
    return;
  }
  let ready = smtpListening;
  if (request.url === "/readyz") {
    try {
      await probeInboundContract();
      ready = ready && (!TLS_REQUIRED || metrics.starttls);
    } catch {
      ready = false;
    }
  }
  response.writeHead(ready ? 200 : 503, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify({ ok: ready, ...metrics }));
});
health.listen(HEALTH_PORT, "0.0.0.0", () =>
  console.log(`[smtp] health endpoint ready on :${HEALTH_PORT}/healthz`),
);

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[smtp] received ${signal}; shutting down`);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  if (tlsReloadTimer) clearInterval(tlsReloadTimer);
  health.close();
  smtp.close(() => {
    clearTimeout(force);
    process.exit(0);
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
