import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import { BlockList, isIP } from "node:net";

import nodemailer from "nodemailer";
import type SMTPPool from "nodemailer/lib/smtp-pool";

import type { EffectiveSmtpConfiguration } from "./runtime-configuration.server";

const CONNECTION_TIMEOUT_MS = 12_000;
const GREETING_TIMEOUT_MS = 12_000;
const SOCKET_TIMEOUT_MS = 45_000;
const PANEL_PORTS = new Set([465, 587]);

export type OutboundSecurity = "starttls" | "tls";

export type OutboundRelayStatus = {
  enabled: boolean;
  configured: boolean;
  host: string | null;
  port: number | null;
  security: OutboundSecurity | null;
  maxRecipients: number;
};

export type OutboundMessage = {
  from: { address: string; name?: string };
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  replyTo?: string;
  inReplyTo?: string;
};

export class OutboundConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundConfigurationError";
  }
}

type ResolvedRelayConfiguration = EffectiveSmtpConfiguration & {
  normalizedHost: string;
  pinnedAddress: string;
};

type CachedTransport = {
  fingerprint: string;
  transporter: nodemailer.Transporter<SMTPPool.SentMessageInfo, SMTPPool.Options>;
  leases: number;
  retired: boolean;
};

type TransportLease = {
  config: ResolvedRelayConfiguration;
  transporter: nodemailer.Transporter<SMTPPool.SentMessageInfo, SMTPPool.Options>;
  release: () => Promise<void>;
};

const blockedRelayAddresses = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedRelayAddresses.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["100::", 64],
  ["2001:2::", 48],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedRelayAddresses.addSubnet(network, prefix, "ipv6");
}

function normalizedRecipientLimit(value: number): number {
  return Number.isInteger(value) && value >= 1 && value <= 50 ? value : 25;
}

function normalizeFqdn(value: string): string | null {
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253 || !host.includes(".") || host.includes("..")) return null;
  const labels = host.split(".");
  if (
    labels.some(
      (label) =>
        label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    return null;
  }
  return host;
}

function isPublicAddress(address: string, family: number): boolean {
  if (family === 4) return !blockedRelayAddresses.check(address, "ipv4");
  if (family === 6) return !blockedRelayAddresses.check(address, "ipv6");
  return false;
}

function validateRelayConfiguration(config: EffectiveSmtpConfiguration): void {
  if (!config.enabled) return;

  const fqdn = normalizeFqdn(config.host);
  if (!fqdn && isIP(config.host.trim()) === 0) {
    throw new OutboundConfigurationError("L'hôte du relais SMTP est absent ou invalide.");
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) {
    throw new OutboundConfigurationError("Le port du relais SMTP est invalide.");
  }
  if (config.security !== "starttls" && config.security !== "tls") {
    throw new OutboundConfigurationError(
      "La sécurité du relais SMTP doit être « starttls » ou « tls ».",
    );
  }
  if (!config.username || config.username.length > 320 || /\s/.test(config.username)) {
    throw new OutboundConfigurationError("L'identifiant du relais SMTP est invalide.");
  }
  if (!config.password || config.password.length > 1_024 || /[\r\n]/.test(config.password)) {
    throw new OutboundConfigurationError(
      "Les identifiants du relais SMTP authentifié sont incomplets.",
    );
  }
  if (config.heloName && !normalizeFqdn(config.heloName) && isIP(config.heloName.trim()) === 0) {
    throw new OutboundConfigurationError(
      "Le nom d'identification SMTP de ce serveur est invalide.",
    );
  }

  if (config.source === "panel") {
    if (!fqdn || isIP(config.host.trim()) !== 0) {
      throw new OutboundConfigurationError(
        "Le panneau accepte uniquement le nom d'hôte public complet d'un relais SMTP.",
      );
    }
    if (!PANEL_PORTS.has(config.port)) {
      throw new OutboundConfigurationError(
        "Le panneau autorise uniquement les ports SMTP sécurisés 465 et 587.",
      );
    }
    if (
      (config.port === 465 && config.security !== "tls") ||
      (config.port === 587 && config.security !== "starttls")
    ) {
      throw new OutboundConfigurationError(
        "Utilisez TLS avec le port 465, ou STARTTLS avec le port 587.",
      );
    }
  }
}

function statusForConfiguration(config: EffectiveSmtpConfiguration): OutboundRelayStatus {
  const maxRecipients = normalizedRecipientLimit(config.maxRecipients);
  if (!config.enabled) {
    return {
      enabled: false,
      configured: false,
      host: null,
      port: null,
      security: null,
      maxRecipients,
    };
  }
  validateRelayConfiguration(config);
  return {
    enabled: true,
    configured: true,
    host: config.host.trim().replace(/\.$/, "").toLowerCase(),
    port: config.port,
    security: config.security,
    maxRecipients,
  };
}

async function resolveRelayConfiguration(
  config: EffectiveSmtpConfiguration,
): Promise<ResolvedRelayConfiguration> {
  validateRelayConfiguration(config);
  if (!config.enabled) {
    throw new OutboundConfigurationError(
      "L'envoi externe n'est pas encore activé par l'administrateur.",
    );
  }

  const rawHost = config.host.trim();
  const family = isIP(rawHost);
  if (family !== 0) {
    if (config.source === "panel") {
      throw new OutboundConfigurationError(
        "Le panneau accepte uniquement le nom d'hôte public complet d'un relais SMTP.",
      );
    }
    return { ...config, normalizedHost: rawHost, pinnedAddress: rawHost };
  }

  const normalizedHost = normalizeFqdn(rawHost);
  if (!normalizedHost) {
    throw new OutboundConfigurationError("L'hôte du relais SMTP est absent ou invalide.");
  }

  const resolved = await dns.lookup(normalizedHost, { all: true, verbatim: true });
  const unique = [...new Map(resolved.map((entry) => [entry.address, entry])).values()];
  if (unique.length === 0) {
    throw Object.assign(new Error("Le relais SMTP ne possède aucune adresse réseau."), {
      code: "ENOTFOUND",
    });
  }
  if (
    config.source === "panel" &&
    unique.some((entry) => !isPublicAddress(entry.address, entry.family))
  ) {
    throw new OutboundConfigurationError(
      "Le relais SMTP configuré depuis le panneau doit résoudre uniquement vers des adresses publiques.",
    );
  }

  // Pin the socket to a validated answer so a second DNS lookup cannot redirect
  // authenticated SMTP credentials towards an internal service. IPv4 is
  // preferred because many private installations do not have IPv6 egress.
  unique.sort(
    (left, right) => left.family - right.family || left.address.localeCompare(right.address),
  );
  return {
    ...config,
    host: normalizedHost,
    normalizedHost,
    pinnedAddress: unique[0].address,
  };
}

function transportFingerprint(config: ResolvedRelayConfiguration): string {
  return createHash("sha256")
    .update("jorgardemail:outbound-transport:v2\0")
    .update(config.source)
    .update("\0")
    .update(config.normalizedHost)
    .update("\0")
    .update(config.pinnedAddress)
    .update("\0")
    .update(String(config.port))
    .update("\0")
    .update(config.security)
    .update("\0")
    .update(config.username)
    .update("\0")
    .update(config.password)
    .update("\0")
    .update(config.heloName || "")
    .digest("base64url");
}

function transportOptions(config: ResolvedRelayConfiguration): SMTPPool.Options {
  return {
    host: config.pinnedAddress,
    port: config.port,
    secure: config.security === "tls",
    requireTLS: config.security === "starttls",
    name: config.heloName,
    auth: {
      user: config.username,
      pass: config.password,
    },
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    disableFileAccess: true,
    disableUrlAccess: true,
    tls: {
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
      servername: config.normalizedHost,
    },
    pool: true,
    maxConnections: 2,
    maxMessages: 50,
    rateDelta: 1_000,
    rateLimit: 5,
    logger: false,
    debug: false,
  };
}

function createTransport(config: ResolvedRelayConfiguration) {
  return nodemailer.createTransport(transportOptions(config));
}

let cachedTransport: CachedTransport | undefined;
let transportLock: Promise<void> = Promise.resolve();

async function withTransportLock<T>(operation: () => Promise<T> | T): Promise<T> {
  const previous = transportLock;
  let unlock!: () => void;
  transportLock = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    unlock();
  }
}

function retireTransport(entry: CachedTransport): void {
  entry.retired = true;
  if (entry.leases === 0) entry.transporter.close();
}

export async function invalidateOutboundRelayTransport(): Promise<void> {
  await withTransportLock(() => {
    const current = cachedTransport;
    cachedTransport = undefined;
    if (current) retireTransport(current);
  });
}

async function acquireEffectiveTransport(): Promise<TransportLease> {
  return withTransportLock(async () => {
    const { loadEffectiveSmtpConfiguration } = await import("./runtime-configuration.server");
    const config = await resolveRelayConfiguration(await loadEffectiveSmtpConfiguration());
    const fingerprint = transportFingerprint(config);

    if (!cachedTransport || cachedTransport.fingerprint !== fingerprint) {
      const previous = cachedTransport;
      cachedTransport = {
        fingerprint,
        transporter: createTransport(config),
        leases: 0,
        retired: false,
      };
      if (previous) retireTransport(previous);
    }

    const entry = cachedTransport!;
    entry.leases += 1;
    let released = false;
    return {
      config,
      transporter: entry.transporter,
      release: async () => {
        if (released) return;
        released = true;
        await withTransportLock(() => {
          entry.leases = Math.max(0, entry.leases - 1);
          if (entry.retired && entry.leases === 0) entry.transporter.close();
        });
      },
    };
  });
}

export async function getOutboundRelayStatus(): Promise<OutboundRelayStatus> {
  try {
    const { loadEffectiveSmtpConfiguration } = await import("./runtime-configuration.server");
    const config = await loadEffectiveSmtpConfiguration();
    const status = statusForConfiguration(config);
    if (!status.enabled) await invalidateOutboundRelayTransport();
    return status;
  } catch {
    await invalidateOutboundRelayTransport();
    const parsedLimit = Number(process.env.OUTBOUND_MAX_RECIPIENTS || "25");
    return {
      enabled: false,
      configured: false,
      host: null,
      port: null,
      security: null,
      maxRecipients: normalizedRecipientLimit(parsedLimit),
    };
  }
}

export async function verifyOutboundRelayConfiguration(
  config: EffectiveSmtpConfiguration,
): Promise<OutboundRelayStatus> {
  const status = statusForConfiguration(config);
  if (!status.enabled) return status;

  const resolved = await resolveRelayConfiguration(config);
  const transporter = createTransport(resolved);
  try {
    await transporter.verify();
    return status;
  } finally {
    transporter.close();
  }
}

export async function verifyOutboundRelay(): Promise<OutboundRelayStatus> {
  const status = await getOutboundRelayStatus();
  if (!status.enabled) return status;

  const lease = await acquireEffectiveTransport();
  try {
    await lease.transporter.verify();
    return { ...status, configured: true, maxRecipients: lease.config.maxRecipients };
  } finally {
    await lease.release();
  }
}

export async function deliverOutboundMessage(message: OutboundMessage) {
  const lease = await acquireEffectiveTransport();
  try {
    const recipientCount = message.to.length + message.cc.length + message.bcc.length;
    if (recipientCount > lease.config.maxRecipients) {
      throw new OutboundConfigurationError(
        `Un message ne peut pas dépasser ${lease.config.maxRecipients} destinataires.`,
      );
    }

    const result = await lease.transporter.sendMail({
      from: message.from,
      envelope: {
        from: message.from.address,
        to: [...message.to, ...message.cc, ...message.bcc],
      },
      to: message.to,
      cc: message.cc.length ? message.cc : undefined,
      bcc: message.bcc.length ? message.bcc : undefined,
      replyTo: message.replyTo,
      inReplyTo: message.inReplyTo,
      references: message.inReplyTo ? [message.inReplyTo] : undefined,
      subject: message.subject,
      text: message.text,
      date: new Date(),
      disableFileAccess: true,
      disableUrlAccess: true,
    });

    return {
      messageId: String(result.messageId || "").slice(0, 998),
      accepted: (result.accepted || []).map(String),
      rejected: (result.rejected || []).map(String),
      response: String(result.response || "").slice(0, 500),
    };
  } finally {
    await lease.release();
  }
}

export function publicOutboundError(
  error: unknown,
  duringDelivery = false,
): { code: string; message: string } {
  if (error instanceof OutboundConfigurationError) {
    return { code: "CONFIGURATION", message: error.message };
  }

  const record =
    error != null && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const code = String(record.code || "SMTP_ERROR")
    .toUpperCase()
    .slice(0, 80);
  if (code === "EAUTH") {
    return {
      code,
      message: "Le relais SMTP a refusé l'authentification. Vérifiez ses identifiants.",
    };
  }
  if (
    code.includes("TLS") ||
    String(record.message || "")
      .toLowerCase()
      .includes("certificate")
  ) {
    return {
      code: "TLS_ERROR",
      message: "La connexion sécurisée au relais SMTP a échoué.",
    };
  }
  const syscall = String(record.syscall || "").toLowerCase();
  const definitelyBeforeDelivery = syscall === "connect" || syscall === "getaddrinfo";
  if (
    duringDelivery &&
    !definitelyBeforeDelivery &&
    ["ETIMEDOUT", "ECONNECTION", "ESOCKET"].includes(code)
  ) {
    return {
      code: "AMBIGUOUS_DELIVERY",
      message:
        "L’état de remise est incertain : le relais a peut-être accepté le message. Vérifiez-le avant de renvoyer.",
    };
  }
  if (
    ["ETIMEDOUT", "ECONNECTION", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ESOCKET"].includes(code)
  ) {
    return {
      code,
      message: "Le relais SMTP est momentanément inaccessible. Réessayez dans un instant.",
    };
  }
  if (["EENVELOPE", "EMESSAGE"].includes(code)) {
    return {
      code,
      message: "Le relais SMTP a refusé l'adresse ou le contenu du message.",
    };
  }
  return {
    code,
    message: "Le message n'a pas pu être remis au relais SMTP.",
  };
}
