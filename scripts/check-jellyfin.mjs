#!/usr/bin/env node

const MAX_RESPONSE_BYTES = 1024 * 1024;

function fail(message) {
  process.stderr.write(`[check-jellyfin] ${message}\n`);
  process.exit(1);
}

function configuredJellyfin() {
  const rawUrl = (process.env.JELLYFIN_URL || "").trim();
  const apiKey = (process.env.JELLYFIN_API_KEY || "").trim();
  if (!rawUrl && !apiKey) return null;
  if (!rawUrl || !apiKey) {
    fail("la configuration Jellyfin historique est incomplète");
  }
  if (!/^[a-zA-Z0-9._~-]{16,256}$/.test(apiKey)) {
    fail("JELLYFIN_URL ou JELLYFIN_API_KEY est absent ou invalide");
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    fail("JELLYFIN_URL n'est pas une adresse valide");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    fail("JELLYFIN_URL doit être une adresse HTTP(S) de serveur sans paramètres");
  }
  return { baseUrl: url.toString().replace(/\/$/, ""), apiKey };
}

async function readBounded(response) {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > MAX_RESPONSE_BYTES) fail("la réponse dépasse 1 Mio");
  if (!response.body) fail("le serveur a renvoyé une réponse vide");

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
        fail("la réponse dépasse 1 Mio");
      }
      raw += decoder.decode(value, { stream: true });
    }
    return raw + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

const configuration = configuredJellyfin();
if (!configuration) {
  process.stdout.write(
    "Validation Jellyfin ignorée : configurez l'adresse et la clé depuis le panneau administrateur\n",
  );
  process.exit(0);
}
const { baseUrl, apiKey } = configuration;
let response;
try {
  response = await fetch(`${baseUrl}/Users`, {
    redirect: "error",
    headers: {
      accept: "application/json",
      authorization:
        `MediaBrowser Client="JorgardeMail", Device="JorgardeMail Server", ` +
        `DeviceId="jorgardemail-server", Version="1.0.0", Token="${apiKey}"`,
      "x-emby-authorization":
        `MediaBrowser Client="JorgardeMail", Device="JorgardeMail Server", ` +
        `DeviceId="jorgardemail-server", Version="1.0.0", Token="${apiKey}"`,
      "x-emby-token": apiKey,
    },
    signal: AbortSignal.timeout(7_000),
  });
} catch {
  fail("Jellyfin est inaccessible depuis le service web");
}
if (!response.ok) fail(`Jellyfin a refusé la clé API configurée (HTTP ${response.status})`);

let users;
try {
  users = JSON.parse(await readBounded(response));
} catch {
  fail("Jellyfin a renvoyé un JSON invalide");
}
if (!Array.isArray(users)) fail("Jellyfin a renvoyé une liste d'utilisateurs invalide");
if (!users.some((user) => typeof user?.Id === "string" && typeof user?.Name === "string")) {
  fail("Jellyfin n'a renvoyé aucun compte utilisateur exploitable");
}

process.stdout.write("Validation des inscriptions Jellyfin réussie\n");
