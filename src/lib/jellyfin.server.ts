const MAX_JELLYFIN_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 7_000;

export type JellyfinConfiguration = {
  baseUrl: string;
  apiKey: string;
};

export type JellyfinUser = {
  Id?: unknown;
  Name?: unknown;
  Policy?: { IsDisabled?: unknown } | null;
};

export type JellyfinAuthentication = {
  AccessToken?: unknown;
  User?: { Id?: unknown; Name?: unknown } | null;
};

type JellyfinSystemInfo = {
  ServerName?: unknown;
  Version?: unknown;
  Id?: unknown;
  OperatingSystem?: unknown;
};

export function normalizeJellyfinConfiguration(
  rawUrl: string,
  rawApiKey: string,
): JellyfinConfiguration {
  const apiKey = rawApiKey.trim();
  const hasUnsafeCharacter = [...apiKey].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 32 || code === 127;
  });
  if (!apiKey || apiKey.length > 512 || hasUnsafeCharacter) {
    throw new Error("La clé API Jellyfin est absente ou invalide.");
  }

  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error("L’adresse Jellyfin est invalide.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Utilisez une adresse HTTP(S) Jellyfin sans identifiants ni paramètres.");
  }
  return { baseUrl: url.toString().replace(/\/$/, ""), apiKey };
}

async function readBoundedText(response: Response, maximum: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maximum) {
    throw new Error("La réponse Jellyfin est trop volumineuse.");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel("response too large").catch(() => {});
        throw new Error("La réponse Jellyfin est trop volumineuse.");
      }
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function jellyfinJson<T>(response: Response, maximum: number): Promise<T> {
  const raw = await readBoundedText(response, maximum);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error("Jellyfin a renvoyé une réponse JSON invalide.");
  }
}

function authorization(token?: string, deviceId = "jorgardemail-server"): string {
  const fields = [
    'MediaBrowser Client="JorgardeMail"',
    'Device="JorgardeMail Server"',
    `DeviceId="${deviceId.replace(/[^a-zA-Z0-9_-]/g, "")}"`,
    'Version="1.0.0"',
  ];
  if (token) fields.push(`Token="${token.replace(/["\\]/g, "")}"`);
  return fields.join(", ");
}

function apiHeaders(apiKey: string): HeadersInit {
  const value = authorization(apiKey);
  return {
    accept: "application/json",
    authorization: value,
    "x-emby-authorization": value,
    "x-emby-token": apiKey,
  };
}

async function fetchJellyfin(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error(
      "Jellyfin est inaccessible depuis le conteneur web. Utilisez son adresse LAN, jamais localhost.",
    );
  }
}

function assertAuthorized(response: Response, action: string): void {
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      "Jellyfin a refusé la clé API. Créez une nouvelle clé dans son tableau de bord.",
    );
  }
  if (!response.ok) throw new Error(`${action} a échoué (HTTP ${response.status}).`);
}

export async function fetchJellyfinUsers(baseUrl: string, apiKey: string): Promise<JellyfinUser[]> {
  const response = await fetchJellyfin(`${baseUrl}/Users`, { headers: apiHeaders(apiKey) });
  assertAuthorized(response, "La lecture des utilisateurs Jellyfin");
  const users = await jellyfinJson<unknown>(response, MAX_JELLYFIN_RESPONSE_BYTES);
  if (!Array.isArray(users))
    throw new Error("Jellyfin a renvoyé une liste d’utilisateurs invalide.");
  return users as JellyfinUser[];
}

export async function testJellyfinConnection(configuration: JellyfinConfiguration) {
  const [users, infoResponse] = await Promise.all([
    fetchJellyfinUsers(configuration.baseUrl, configuration.apiKey),
    fetchJellyfin(`${configuration.baseUrl}/System/Info`, {
      headers: apiHeaders(configuration.apiKey),
    }),
  ]);
  assertAuthorized(infoResponse, "La lecture des informations système Jellyfin");
  const info = await jellyfinJson<JellyfinSystemInfo>(infoResponse, 256 * 1024);
  const visibleUsers = users
    .filter((user) => typeof user.Id === "string" && typeof user.Name === "string")
    .map((user) => ({
      id: String(user.Id),
      name: String(user.Name),
      disabled: user.Policy?.IsDisabled === true,
    }));
  if (visibleUsers.length === 0) {
    throw new Error("Jellyfin ne renvoie aucun compte utilisateur exploitable.");
  }
  return {
    ok: true as const,
    serverName: typeof info.ServerName === "string" ? info.ServerName : "Jellyfin",
    version: typeof info.Version === "string" ? info.Version : null,
    operatingSystem: typeof info.OperatingSystem === "string" ? info.OperatingSystem : null,
    userCount: visibleUsers.length,
    enabledUserCount: visibleUsers.filter((user) => !user.disabled).length,
    users: visibleUsers.slice(0, 100),
  };
}

export async function authenticateJellyfinUser(
  baseUrl: string,
  username: string,
  password: string,
  deviceId: string,
): Promise<JellyfinAuthentication | null> {
  const authorizationValue = authorization(undefined, deviceId);
  const response = await fetchJellyfin(`${baseUrl}/Users/AuthenticateByName`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: authorizationValue,
      "x-emby-authorization": authorizationValue,
      "content-type": "application/json",
    },
    body: JSON.stringify({ Username: username, Pw: password }),
  });
  if (response.status === 401) return null;
  if (!response.ok)
    throw new Error(`L’authentification Jellyfin a échoué (HTTP ${response.status}).`);
  return jellyfinJson<JellyfinAuthentication>(response, 256 * 1024);
}

export async function revokeJellyfinToken(baseUrl: string, token: string): Promise<void> {
  const authorizationValue = authorization(token);
  await fetch(`${baseUrl}/Sessions/Logout`, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: authorizationValue,
      "x-emby-authorization": authorizationValue,
      "x-emby-token": token,
    },
    signal: AbortSignal.timeout(3_000),
  }).catch(() => {});
}
