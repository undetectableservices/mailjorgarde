import nodemailer from "nodemailer";
import type SMTPPool from "nodemailer/lib/smtp-pool";
import { isIP } from "node:net";

const CONNECTION_TIMEOUT_MS = 12_000;
const GREETING_TIMEOUT_MS = 12_000;
const SOCKET_TIMEOUT_MS = 45_000;

export type OutboundSecurity = "starttls" | "tls";

export type OutboundRelayStatus = {
  enabled: boolean;
  configured: boolean;
  host: string | null;
  port: number | null;
  security: OutboundSecurity | null;
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

type RelayConfig = {
  enabled: boolean;
  host: string;
  port: number;
  security: OutboundSecurity;
  username: string;
  password: string;
  heloName?: string;
};

function readRelayConfig(): RelayConfig {
  const enabled = (process.env.OUTBOUND_SMTP_ENABLED || "false").trim().toLowerCase() === "true";
  const host = (process.env.OUTBOUND_SMTP_HOST || "").trim();
  const rawPort = (process.env.OUTBOUND_SMTP_PORT || "587").trim();
  const security = (process.env.OUTBOUND_SMTP_SECURITY || "starttls")
    .trim()
    .toLowerCase() as OutboundSecurity;
  const username = (process.env.OUTBOUND_SMTP_USERNAME || "").trim();
  const encodedPassword = (process.env.OUTBOUND_SMTP_PASSWORD_B64 || "").trim();
  let password = "";
  if (encodedPassword) {
    try {
      if (encodedPassword.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encodedPassword)) {
        throw new Error("invalid base64");
      }
      const decoded = Buffer.from(encodedPassword, "base64");
      if (decoded.toString("base64") !== encodedPassword) throw new Error("invalid base64");
      password = decoded.toString("utf8");
    } catch {
      throw new OutboundConfigurationError("Le secret du relais SMTP est illisible.");
    }
  }
  const heloName = (process.env.MAIL_HOSTNAME || "").trim() || undefined;
  const port = Number(rawPort);

  if (!enabled) return { enabled, host, port, security, username, password, heloName };
  if (!host || host.length > 253 || /[\s/@]/.test(host)) {
    throw new OutboundConfigurationError("L'hôte du relais SMTP est absent ou invalide.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new OutboundConfigurationError("Le port du relais SMTP est invalide.");
  }
  if (security !== "starttls" && security !== "tls") {
    throw new OutboundConfigurationError(
      "La sécurité du relais SMTP doit être « starttls » ou « tls ».",
    );
  }
  if (!username || !password) {
    throw new OutboundConfigurationError(
      "Les identifiants du relais SMTP authentifié sont incomplets.",
    );
  }
  return { enabled, host, port, security, username, password, heloName };
}

export function getOutboundRelayStatus(): OutboundRelayStatus {
  try {
    const config = readRelayConfig();
    return {
      enabled: config.enabled,
      configured: config.enabled && Boolean(config.host && config.username && config.password),
      host: config.enabled ? config.host : null,
      port: config.enabled ? config.port : null,
      security: config.enabled ? config.security : null,
    };
  } catch {
    return {
      enabled: (process.env.OUTBOUND_SMTP_ENABLED || "false").trim().toLowerCase() === "true",
      configured: false,
      host: null,
      port: null,
      security: null,
    };
  }
}

let cachedTransport:
  | {
      fingerprint: string;
      transporter: nodemailer.Transporter<SMTPPool.SentMessageInfo>;
    }
  | undefined;

function getTransporter(): nodemailer.Transporter<SMTPPool.SentMessageInfo> {
  const config = readRelayConfig();
  if (!config.enabled) {
    throw new OutboundConfigurationError(
      "L'envoi externe n'est pas encore activé par l'administrateur.",
    );
  }

  // The password is intentionally represented only by its length in the cache
  // fingerprint. Rebuilding/restarting the container is required after config
  // changes, which is also how the root-owned env file is safely reloaded.
  const fingerprint = [
    config.host,
    config.port,
    config.security,
    config.username,
    config.password.length,
  ].join("|");
  if (cachedTransport?.fingerprint === fingerprint) return cachedTransport.transporter;

  const options: SMTPPool.Options = {
    host: config.host,
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
      servername: isIP(config.host) ? undefined : config.host,
    },
    pool: true,
    maxConnections: 2,
    maxMessages: 50,
    rateDelta: 1_000,
    rateLimit: 5,
    logger: false,
    debug: false,
  };

  const transporter = nodemailer.createTransport(options);
  cachedTransport = { fingerprint, transporter };
  return transporter;
}

export async function verifyOutboundRelay(): Promise<OutboundRelayStatus> {
  const status = getOutboundRelayStatus();
  if (!status.enabled) return status;
  await getTransporter().verify();
  return { ...status, configured: true };
}

export async function deliverOutboundMessage(message: OutboundMessage) {
  const result = await getTransporter().sendMail({
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
  if (["ETIMEDOUT", "ECONNECTION", "ECONNREFUSED", "ENOTFOUND", "ESOCKET"].includes(code)) {
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
