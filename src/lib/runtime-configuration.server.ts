import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { Json } from "@/integrations/supabase/types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type ConfigurationSource = "panel" | "installer";
export type RuntimeSmtpSecurity = "starttls" | "tls";

export type EffectiveJellyfinConfiguration = {
  enabled: boolean;
  url: string;
  apiKey: string;
  source: ConfigurationSource;
};

export type EffectiveSmtpConfiguration = {
  enabled: boolean;
  host: string;
  port: number;
  security: RuntimeSmtpSecurity;
  username: string;
  password: string;
  maxRecipients: number;
  heloName?: string;
  source: ConfigurationSource;
};

type StoredJellyfin = {
  revision: number;
  managed: boolean;
  enabled: boolean;
  url: string;
  apiKeyEncrypted: string;
  updatedAt: string | null;
};

type StoredSmtp = {
  revision: number;
  managed: boolean;
  enabled: boolean;
  host: string;
  port: number;
  security: RuntimeSmtpSecurity;
  username: string;
  passwordEncrypted: string;
  maxRecipients: number;
  updatedAt: string | null;
};

const ENCRYPTION_CONTEXT = "jorgardemail:runtime-configuration:v1";

function record(value: Json | null): Record<string, Json | undefined> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Json | undefined>)
    : null;
}

function textValue(value: Json | undefined): string {
  return typeof value === "string" ? value : "";
}

function boolValue(value: Json | undefined, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function integerValue(value: Json | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function encryptionKey(): Buffer {
  const encoded = (process.env.RUNTIME_CONFIG_KEY_B64 || "").trim();
  try {
    if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error("invalid key");
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32 || key.toString("base64") !== encoded) throw new Error("invalid key");
    return key;
  } catch {
    throw new Error("La clé dédiée de configuration du serveur est absente ou invalide.");
  }
}

function aad(purpose: "jellyfin" | "smtp"): Buffer {
  return Buffer.from(`${ENCRYPTION_CONTEXT}:${purpose}`, "utf8");
}

function encryptSecret(value: string, purpose: "jellyfin" | "smtp"): string {
  if (!value) return "";
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
  cipher.setAAD(aad(purpose));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    "v1",
    nonce.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

function decryptSecret(value: string, purpose: "jellyfin" | "smtp"): string {
  if (!value) return "";
  const [version, nonceRaw, tagRaw, encryptedRaw, extra] = value.split(".");
  if (version !== "v1" || !nonceRaw || !tagRaw || !encryptedRaw || extra) {
    throw new Error("Un secret enregistré est illisible. Saisissez-le à nouveau.");
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      Buffer.from(nonceRaw, "base64url"),
    );
    decipher.setAAD(aad(purpose));
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedRaw, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Un secret enregistré est illisible. Saisissez-le à nouveau.");
  }
}

function decodeEnvironmentPassword(): string {
  const encoded = (process.env.OUTBOUND_SMTP_PASSWORD_B64 || "").trim();
  if (!encoded) return "";
  try {
    if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error();
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.toString("base64") !== encoded) throw new Error();
    return decoded.toString("utf8");
  } catch {
    throw new Error("Le secret SMTP défini par l’installateur est illisible.");
  }
}

async function readStoredJellyfin(): Promise<StoredJellyfin> {
  const { data, error } = await supabaseAdmin.rpc("get_jellyfin_runtime_configuration");
  if (error) {
    console.error("[runtime-config] Jellyfin read failed", { code: error.code });
    throw new Error("Impossible de lire la configuration Jellyfin.");
  }
  const row = record(data);
  return {
    revision: integerValue(row?.revision, 0, 0, Number.MAX_SAFE_INTEGER),
    managed: boolValue(row?.managed, false),
    enabled: boolValue(row?.enabled, false),
    url: textValue(row?.url),
    apiKeyEncrypted: textValue(row?.api_key_encrypted),
    updatedAt: textValue(row?.updated_at) || null,
  };
}

async function readStoredSmtp(): Promise<StoredSmtp> {
  const { data, error } = await supabaseAdmin.rpc("get_smtp_runtime_configuration");
  if (error) {
    console.error("[runtime-config] SMTP read failed", { code: error.code });
    throw new Error("Impossible de lire la configuration SMTP.");
  }
  const row = record(data);
  return {
    revision: integerValue(row?.revision, 0, 0, Number.MAX_SAFE_INTEGER),
    managed: boolValue(row?.managed, false),
    enabled: boolValue(row?.enabled, false),
    host: textValue(row?.host),
    port: integerValue(row?.port, 587, 1, 65_535),
    security: textValue(row?.security) === "tls" ? "tls" : "starttls",
    username: textValue(row?.username),
    passwordEncrypted: textValue(row?.password_encrypted),
    maxRecipients: integerValue(row?.max_recipients, 25, 1, 50),
    updatedAt: textValue(row?.updated_at) || null,
  };
}

function effectiveJellyfin(stored: StoredJellyfin): EffectiveJellyfinConfiguration {
  if (stored.managed) {
    return {
      enabled: stored.enabled,
      url: stored.url,
      apiKey: decryptSecret(stored.apiKeyEncrypted, "jellyfin"),
      source: "panel",
    };
  }
  const url = (process.env.JELLYFIN_URL || "").trim();
  const apiKey = (process.env.JELLYFIN_API_KEY || "").trim();
  return { enabled: Boolean(url && apiKey), url, apiKey, source: "installer" };
}

function effectiveSmtp(stored: StoredSmtp): EffectiveSmtpConfiguration {
  if (stored.managed) {
    return {
      enabled: stored.enabled,
      host: stored.host,
      port: stored.port,
      security: stored.security,
      username: stored.username,
      password: decryptSecret(stored.passwordEncrypted, "smtp"),
      maxRecipients: stored.maxRecipients,
      heloName: (process.env.MAIL_HOSTNAME || "").trim() || undefined,
      source: "panel",
    };
  }
  const port = Number(process.env.OUTBOUND_SMTP_PORT || "587");
  const limit = Number(process.env.OUTBOUND_MAX_RECIPIENTS || "25");
  return {
    enabled: (process.env.OUTBOUND_SMTP_ENABLED || "false").trim().toLowerCase() === "true",
    host: (process.env.OUTBOUND_SMTP_HOST || "").trim(),
    port: Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : 587,
    security:
      process.env.OUTBOUND_SMTP_SECURITY?.trim().toLowerCase() === "tls" ? "tls" : "starttls",
    username: (process.env.OUTBOUND_SMTP_USERNAME || "").trim(),
    password: decodeEnvironmentPassword(),
    maxRecipients: Number.isInteger(limit) && limit >= 1 && limit <= 50 ? limit : 25,
    heloName: (process.env.MAIL_HOSTNAME || "").trim() || undefined,
    source: "installer",
  };
}

export async function loadEffectiveJellyfinConfiguration() {
  return effectiveJellyfin(await readStoredJellyfin());
}

export async function loadEffectiveSmtpConfiguration() {
  return effectiveSmtp(await readStoredSmtp());
}

export async function getAdminRuntimeConfigurationState() {
  const [jellyfinStored, smtpStored] = await Promise.all([readStoredJellyfin(), readStoredSmtp()]);
  const jellyfin = effectiveJellyfin(jellyfinStored);
  const smtp = effectiveSmtp(smtpStored);
  return {
    jellyfin: {
      revision: jellyfinStored.revision,
      enabled: jellyfin.enabled,
      url: jellyfin.url,
      apiKeySet: Boolean(jellyfin.apiKey),
      source: jellyfin.source,
      updatedAt: jellyfinStored.updatedAt,
    },
    smtp: {
      revision: smtpStored.revision,
      enabled: smtp.enabled,
      host: smtp.host,
      port: smtp.port,
      security: smtp.security,
      username: smtp.username,
      passwordSet: Boolean(smtp.password),
      maxRecipients: smtp.maxRecipients,
      source: smtp.source,
      updatedAt: smtpStored.updatedAt,
    },
  };
}

export async function saveJellyfinRuntimeConfiguration(
  updatedBy: string,
  input: {
    expectedRevision: number;
    managed: boolean;
    enabled: boolean;
    url: string;
    apiKey?: string;
  },
) {
  const stored = await readStoredJellyfin();
  if (stored.revision !== input.expectedRevision) {
    throw new Error("La configuration Jellyfin a changé. Rechargez la page puis réessayez.");
  }
  let encrypted = stored.apiKeyEncrypted;
  if (input.apiKey !== undefined) encrypted = encryptSecret(input.apiKey, "jellyfin");
  if (input.managed && !encrypted) {
    const inherited = (process.env.JELLYFIN_API_KEY || "").trim();
    if (inherited) encrypted = encryptSecret(inherited, "jellyfin");
  }
  const { error } = await supabaseAdmin.rpc("set_jellyfin_runtime_configuration", {
    p_api_key_encrypted: encrypted || null,
    p_enabled: input.enabled,
    p_expected_revision: input.expectedRevision,
    p_managed: input.managed,
    p_updated_by: updatedBy,
    p_url: input.url || null,
  });
  if (error) {
    if (error.code === "40001")
      throw new Error("La configuration a changé. Rechargez puis réessayez.");
    console.error("[runtime-config] Jellyfin update failed", { code: error.code });
    throw new Error("Impossible d’enregistrer la configuration Jellyfin.");
  }
  return getAdminRuntimeConfigurationState();
}

export async function saveSmtpRuntimeConfiguration(
  updatedBy: string,
  input: {
    expectedRevision: number;
    managed: boolean;
    enabled: boolean;
    host: string;
    port: number;
    security: RuntimeSmtpSecurity;
    username: string;
    password?: string;
    maxRecipients: number;
  },
) {
  const stored = await readStoredSmtp();
  if (stored.revision !== input.expectedRevision) {
    throw new Error("La configuration SMTP a changé. Rechargez la page puis réessayez.");
  }
  let encrypted = stored.passwordEncrypted;
  if (input.password !== undefined) encrypted = encryptSecret(input.password, "smtp");
  if (input.managed && !encrypted) {
    const inherited = decodeEnvironmentPassword();
    if (inherited) encrypted = encryptSecret(inherited, "smtp");
  }
  const { error } = await supabaseAdmin.rpc("set_smtp_runtime_configuration", {
    p_enabled: input.enabled,
    p_expected_revision: input.expectedRevision,
    p_host: input.host || null,
    p_managed: input.managed,
    p_max_recipients: input.maxRecipients,
    p_password_encrypted: encrypted || null,
    p_port: input.port,
    p_security: input.security,
    p_updated_by: updatedBy,
    p_username: input.username || null,
  });
  if (error) {
    if (error.code === "40001")
      throw new Error("La configuration a changé. Rechargez puis réessayez.");
    console.error("[runtime-config] SMTP update failed", { code: error.code });
    throw new Error("Impossible d’enregistrer la configuration SMTP.");
  }
  return getAdminRuntimeConfigurationState();
}
