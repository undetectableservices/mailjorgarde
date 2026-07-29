import assert from "node:assert/strict";
import test from "node:test";
import {
  FixedWindowLimiter,
  FROZEN_INBOUND_LIMITS,
  MAX_SIGNED_WEBHOOK_BYTES,
  createDeliveryId,
  deriveWebhookRequestBytes,
  deterministicUuid,
  encodeRawMessage,
  normalizeEnvelopeSender,
  normalizeMailbox,
  signWebhookBody,
  truncateUtf8,
  verifyWebhookSignature,
} from "./lib.js";

test("normalizes supported envelope recipients and rejects malformed values", () => {
  assert.equal(normalizeMailbox(" Alice.Tag+news@Example.COM "), "alice.tag+news@example.com");
  assert.equal(normalizeMailbox("missing-at.example.com"), null);
  assert.equal(normalizeMailbox("two@@example.com"), null);
  assert.equal(normalizeMailbox("bad space@example.com"), null);
});

test("webhook signatures cover timestamp and exact body", () => {
  const secret = "a".repeat(64);
  const body = JSON.stringify({ action: "validate", recipient: "a@example.com" });
  const signature = signWebhookBody(secret, "1720000000000", body);
  assert.equal(verifyWebhookSignature(secret, "1720000000000", body, `v1=${signature}`), true);
  assert.equal(verifyWebhookSignature(secret, "1720000000001", body, `v1=${signature}`), false);
  assert.equal(
    verifyWebhookSignature(secret, "1720000000000", `${body} `, `v1=${signature}`),
    false,
  );
});

test("delivery IDs are random per SMTP transaction", () => {
  const one = createDeliveryId();
  const two = createDeliveryId();
  assert.match(one, /^[a-f0-9]{64}$/);
  assert.match(two, /^[a-f0-9]{64}$/);
  assert.notEqual(one, two);
});

test("accepts RFC-compatible ASCII envelope senders separately from managed recipients", () => {
  assert.equal(normalizeEnvelopeSender("bounce=user@example.net"), "bounce=user@example.net");
  assert.equal(normalizeEnvelopeSender('"quoted local"@example.net'), '"quoted local"@example.net');
  assert.equal(normalizeEnvelopeSender("bad\r\n@example.net"), null);
});

test("the signed-request limit is derived from the frozen deployment limits", () => {
  assert.equal(deriveWebhookRequestBytes(FROZEN_INBOUND_LIMITS), MAX_SIGNED_WEBHOOK_BYTES);
});

test("deterministic UUIDs are valid and stable", () => {
  const one = deterministicUuid("delivery", "mailbox");
  assert.match(one, /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(one, deterministicUuid("delivery", "mailbox"));
  assert.notEqual(one, deterministicUuid("delivery", "other-mailbox"));
});

test("raw messages use lossless base64 for a predictable signed payload", () => {
  assert.deepEqual(encodeRawMessage(Buffer.from("hello \u2603", "utf8")), {
    encoding: "base64",
    data: "aGVsbG8g4piD",
  });
  assert.deepEqual(encodeRawMessage(Buffer.from([0xff, 0xfe])), {
    encoding: "base64",
    data: "//4=",
  });
});

test("UTF-8 truncation respects the byte ceiling", () => {
  const result = truncateUtf8("abcd\u2603", 5);
  assert.ok(Buffer.byteLength(result, "utf8") <= 5);
  assert.equal(result, "abcd");
});

test("fixed-window limiter resets and prunes", () => {
  const limiter = new FixedWindowLimiter(2, 1000);
  assert.equal(limiter.consume("ip", 0), true);
  assert.equal(limiter.consume("ip", 10), true);
  assert.equal(limiter.consume("ip", 20), false);
  assert.equal(limiter.consume("ip", 1000), true);
  limiter.prune(4000);
  assert.equal(limiter.consume("ip", 4000), true);
});
