#!/usr/bin/env node

const MAX_RESPONSE_BYTES = 1024 * 1024;

function fail(message) {
  process.stderr.write(`[check-jellyfin] ${message}\n`);
  process.exit(1);
}

function configuredJellyfin() {
  const rawUrl = (process.env.JELLYFIN_URL || "").trim();
  const apiKey = (process.env.JELLYFIN_API_KEY || "").trim();
  if (!rawUrl || !/^[a-zA-Z0-9._~-]{16,256}$/.test(apiKey)) {
    fail("JELLYFIN_URL or JELLYFIN_API_KEY is missing or invalid");
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    fail("JELLYFIN_URL is not a valid URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    fail("JELLYFIN_URL must be a plain HTTP(S) server URL");
  }
  return { baseUrl: url.toString().replace(/\/$/, ""), apiKey };
}

async function readBounded(response) {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > MAX_RESPONSE_BYTES) fail("response exceeded 1 MiB");
  if (!response.body) fail("server returned an empty response");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel("response too large").catch(() => {});
        fail("response exceeded 1 MiB");
      }
      raw += decoder.decode(value, { stream: true });
    }
    return raw + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

const { baseUrl, apiKey } = configuredJellyfin();
let response;
try {
  response = await fetch(`${baseUrl}/Users`, {
    headers: {
      accept: "application/json",
      authorization:
        `MediaBrowser Client="JorgardeMail", Device="JorgardeMail Server", ` +
        `DeviceId="jorgardemail-server", Version="1.0.0", Token="${apiKey}"`,
    },
    signal: AbortSignal.timeout(7_000),
  });
} catch {
  fail("Jellyfin is unreachable from the web container");
}
if (!response.ok) fail(`Jellyfin rejected the configured API key (HTTP ${response.status})`);

let users;
try {
  users = JSON.parse(await readBounded(response));
} catch {
  fail("Jellyfin returned invalid JSON");
}
if (!Array.isArray(users)) fail("Jellyfin returned an invalid user list");
if (!users.some((user) => typeof user?.Id === "string" && typeof user?.Name === "string")) {
  fail("Jellyfin did not return any usable user accounts");
}

process.stdout.write("Jellyfin registration gate verified\n");
