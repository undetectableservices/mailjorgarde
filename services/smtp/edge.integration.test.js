import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import net from "node:net";
import test from "node:test";
import { verifyWebhookSignature } from "./lib.js";

const SECRET = "integration-test-secret-".padEnd(64, "x");
const base64Length = (size) => 4 * Math.ceil(size / 3);
const SIGNED_REQUEST_BYTES =
  64 * 1024 +
  base64Length(10 * 1024 * 1024) +
  base64Length(8 * 1024 * 1024) +
  512 * 1024 * 12 +
  5 * (254 * 6 + 16) +
  32 * ((512 + 255 + 512 + 32 + 128) * 6 + 512);
const EDGE_LIMITS = Object.freeze({
  message_bytes: 10 * 1024 * 1024,
  body_bytes: 512 * 1024,
  recipients: 5,
  attachments: 32,
  attachment_bytes: 8 * 1024 * 1024,
  request_bytes: SIGNED_REQUEST_BYTES,
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function startFakeInboundApi() {
  const deliveries = [];
  const validations = [];
  let deliveryMode = "success";
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const timestamp = request.headers["x-inbound-timestamp"];
      const signature = request.headers["x-inbound-signature"];
      assert.equal(
        verifyWebhookSignature(SECRET, timestamp, body, signature),
        true,
        "edge must sign every API call",
      );
      const payload = JSON.parse(body);
      response.setHeader("content-type", "application/json");
      if (payload.action === "ready") {
        response.end(
          JSON.stringify({ ok: true, service: "inbound-ingest", version: 1, limits: EDGE_LIMITS }),
        );
        return;
      }
      if (payload.action === "validate") {
        validations.push(payload.recipient);
        if (payload.recipient.startsWith("known") && payload.recipient.endsWith("@example.com")) {
          response.end(JSON.stringify({ ok: true, canonical_recipient: payload.recipient }));
        } else {
          response.writeHead(404).end(JSON.stringify({ ok: false, code: "unknown_recipient" }));
        }
        return;
      }
      deliveries.push(payload);
      if (deliveryMode === "failure") {
        response.writeHead(503).end(JSON.stringify({ ok: false, code: "temporary_failure" }));
      } else if (deliveryMode === "empty-success") {
        response.writeHead(204).end();
      } else if (deliveryMode === "false-success") {
        response.end(JSON.stringify({ ok: false, code: "not_persisted" }));
      } else if (deliveryMode === "mismatch") {
        response.end(
          JSON.stringify({
            ok: true,
            delivery_id: "0".repeat(64),
            recipients: payload.recipients.length,
            attachments: payload.attachments.length,
          }),
        );
      } else {
        response.end(
          JSON.stringify({
            ok: true,
            delivery_id: payload.delivery_id,
            recipients: payload.recipients.length,
            attachments: payload.attachments.length,
          }),
        );
      }
    });
  });
  return {
    server,
    deliveries,
    validations,
    setDeliveryMode(value) {
      deliveryMode = value;
    },
  };
}

async function readReply(socket) {
  let buffer = "";
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\r\n").filter(Boolean);
      if (lines.length === 0) return;
      const first = lines[0].slice(0, 3);
      if (lines.some((line) => line.startsWith(`${first} `))) {
        cleanup();
        resolve(lines.join("\n"));
      }
    };
    const cleanup = () => {
      socket.off("error", onError);
      socket.off("data", onData);
    };
    socket.on("error", onError);
    socket.on("data", onData);
  });
}

async function connectSmtp(port) {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  assert.match(await readReply(socket), /^220 /);
  socket.write("EHLO sender.example\r\n");
  assert.match(await readReply(socket), /^250[ -]/);
  return socket;
}

async function command(socket, value) {
  socket.write(`${value}\r\n`);
  return readReply(socket);
}

async function sendMessage(port, recipient, raw) {
  const socket = await connectSmtp(port);
  try {
    assert.match(await command(socket, "MAIL FROM:<sender@example.net>"), /^250 /);
    const recipientReply = await command(socket, `RCPT TO:<${recipient}>`);
    if (!recipientReply.startsWith("250 ")) return recipientReply;
    assert.match(await command(socket, "DATA"), /^354 /);
    socket.write(`${raw.replace(/^\./gm, "..")}\r\n.\r\n`);
    return await readReply(socket);
  } finally {
    socket.end();
  }
}

test("SMTP edge fails closed when the webhook secret is absent", async () => {
  const env = { ...process.env };
  delete env.INBOUND_WEBHOOK_SECRET;
  const child = spawn(process.execPath, ["index.js"], {
    cwd: new URL(".", import.meta.url),
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /INBOUND_WEBHOOK_SECRET is required/);
});

test("SMTP edge rejects unknown recipients and never acknowledges failed persistence", async (t) => {
  const fake = startFakeInboundApi();
  await new Promise((resolve, reject) => {
    fake.server.once("error", reject);
    fake.server.listen(0, "127.0.0.1", resolve);
  });
  const apiPort = fake.server.address().port;
  const smtpPort = await freePort();
  const healthPort = await freePort();
  const child = spawn(process.execPath, ["index.js"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      INBOUND_WEBHOOK_SECRET: SECRET,
      WEBHOOK_URL: `http://127.0.0.1:${apiPort}`,
      SMTP_HOSTNAME: "mail.example.com",
      SMTP_PORT: String(smtpPort),
      HEALTH_PORT: String(healthPort),
      MAX_RECIPIENT_ATTEMPTS: "6",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => (logs += chunk));
  child.stderr.on("data", (chunk) => (logs += chunk));
  t.after(async () => {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    await new Promise((resolve) => fake.server.close(resolve));
  });

  const started = Date.now();
  while (!logs.includes("inbound SMTP ready")) {
    if (child.exitCode !== null) throw new Error(`SMTP edge exited early:\n${logs}`);
    if (Date.now() - started > 5000) throw new Error(`SMTP edge did not start:\n${logs}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.match(
    await sendMessage(smtpPort, "unknown@example.com", "Subject: rejected\r\n\r\nno"),
    /^550 /,
  );
  assert.equal(fake.deliveries.length, 0);

  // Explicit open-relay regression: an unrelated sender cannot use this MX
  // receiver to deliver to an unrelated external domain.
  const relaySocket = await connectSmtp(smtpPort);
  assert.match(await command(relaySocket, "MAIL FROM:<test@notyourdomain.example>"), /^250 /);
  assert.match(await command(relaySocket, "RCPT TO:<randomexternal@gmail.com>"), /^550 /);
  relaySocket.end();

  const abuseSocket = await connectSmtp(smtpPort);
  assert.match(await command(abuseSocket, "MAIL FROM:<sender@example.net>"), /^250 /);
  assert.match(await command(abuseSocket, "RCPT TO:<unknown-cache@example.com>"), /^550 /);
  assert.match(await command(abuseSocket, "RCPT TO:<unknown-cache@example.com>"), /^550 /);
  assert.equal(
    fake.validations.filter((recipient) => recipient === "unknown-cache@example.com").length,
    1,
  );
  assert.match(await command(abuseSocket, "RCPT TO:<known1@example.com>"), /^250 /);
  assert.match(await command(abuseSocket, "RCPT TO:<known2@example.com>"), /^250 /);
  assert.match(await command(abuseSocket, "RCPT TO:<known3@example.com>"), /^250 /);
  assert.match(await command(abuseSocket, "RCPT TO:<known4@example.com>"), /^250 /);
  assert.match(await command(abuseSocket, "RCPT TO:<known5@example.com>"), /^452 /);
  abuseSocket.end();

  const recipientCapSocket = await connectSmtp(smtpPort);
  assert.match(await command(recipientCapSocket, "MAIL FROM:<sender@example.net>"), /^250 /);
  assert.match(await command(recipientCapSocket, "RCPT TO:<known1@example.com>"), /^250 /);
  assert.match(await command(recipientCapSocket, "RCPT TO:<known2@example.com>"), /^250 /);
  assert.match(await command(recipientCapSocket, "RCPT TO:<known3@example.com>"), /^250 /);
  assert.match(await command(recipientCapSocket, "RCPT TO:<known4@example.com>"), /^250 /);
  assert.match(await command(recipientCapSocket, "RCPT TO:<known5@example.com>"), /^250 /);
  assert.match(await command(recipientCapSocket, "RCPT TO:<known6@example.com>"), /^452 /);
  recipientCapSocket.end();

  const resetSocket = await connectSmtp(smtpPort);
  assert.match(await command(resetSocket, "MAIL FROM:<sender@example.net>"), /^250 /);
  assert.match(await command(resetSocket, "RCPT TO:<known1@example.com>"), /^250 /);
  assert.match(await command(resetSocket, "RCPT TO:<known2@example.com>"), /^250 /);
  assert.match(await command(resetSocket, "RCPT TO:<known3@example.com>"), /^250 /);
  assert.match(await command(resetSocket, "RCPT TO:<known4@example.com>"), /^250 /);
  assert.match(await command(resetSocket, "RCPT TO:<known5@example.com>"), /^250 /);
  assert.match(await command(resetSocket, "RSET"), /^250 /);
  assert.match(await command(resetSocket, "MAIL FROM:<bounce=user@example.net>"), /^250 /);
  assert.match(await command(resetSocket, "RCPT TO:<known6@example.com>"), /^250 /);
  resetSocket.end();

  const sizeSocket = await connectSmtp(smtpPort);
  assert.match(await command(sizeSocket, "MAIL FROM:<sender@example.net> SIZE=10485761"), /^552 /);
  sizeSocket.end();
  assert.equal(fake.deliveries.length, 0);

  const raw = [
    "From: Sender <sender@example.net>",
    "Subject: durable",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="edge-test"',
    "",
    "--edge-test",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "hello",
    "--edge-test",
    'Content-Type: text/plain; name="note.txt"',
    'Content-Disposition: attachment; filename="note.txt"',
    "Content-Transfer-Encoding: base64",
    "Content-ID: <note-1>",
    "",
    "YXR0YWNobWVudA==",
    "--edge-test--",
  ].join("\r\n");
  fake.setDeliveryMode("failure");
  assert.match(await sendMessage(smtpPort, "known@example.com", raw), /^451 /);
  assert.equal(fake.deliveries.length, 1);

  fake.setDeliveryMode("empty-success");
  assert.match(await sendMessage(smtpPort, "known@example.com", raw), /^451 /);
  fake.setDeliveryMode("false-success");
  assert.match(await sendMessage(smtpPort, "known@example.com", raw), /^451 /);
  fake.setDeliveryMode("mismatch");
  assert.match(await sendMessage(smtpPort, "known@example.com", raw), /^451 /);

  fake.setDeliveryMode("success");
  assert.match(await sendMessage(smtpPort, "known@example.com", raw), /^250 /);
  assert.match(await sendMessage(smtpPort, "known@example.com", raw), /^250 /);
  assert.equal(fake.deliveries.length, 6);
  assert.notEqual(fake.deliveries[4].delivery_id, fake.deliveries[5].delivery_id);
  assert.equal(fake.deliveries[4].size_bytes, Buffer.byteLength(`${raw}\r\n`, "utf8"));
  assert.equal(fake.deliveries[4].recipients[0], "known@example.com");
  assert.equal(fake.deliveries[4].attachments.length, 1);
  assert.equal(fake.deliveries[4].attachments[0].filename, "note.txt");
  assert.equal(fake.deliveries[4].attachments[0].content_base64, "YXR0YWNobWVudA==");
  assert.equal(fake.deliveries[4].attachments[0].content_id, "<note-1>");

  const health = await fetch(`http://127.0.0.1:${healthPort}/healthz`).then((response) =>
    response.json(),
  );
  assert.equal(health.ok, true);
  assert.equal(health.acceptedMessages, 2);
  assert.equal(health.temporaryFailures, 4);
  const ready = await fetch(`http://127.0.0.1:${healthPort}/readyz`);
  assert.equal(ready.status, 200);
});
