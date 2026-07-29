import net from "net";
import { promises as dns } from "node:dns";

export type PortResult = {
  port: number;
  host: string;
  open: boolean;
  banner?: string;
  error?: string;
  ms: number;
};

export type DnsRecordType = "A" | "AAAA" | "MX" | "TXT";

/** Try a raw TCP connect and (optionally) read the first line the peer sends. */
export async function probeTcp(
  host: string,
  port: number,
  readBanner = false,
  timeoutMs = 6000,
): Promise<PortResult> {
  const started = Date.now();
  return new Promise<PortResult>((resolve) => {
    let settled = false;
    const done = (r: Partial<PortResult>) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* noop */
      }
      resolve({ host, port, open: false, ms: Date.now() - started, ...r });
    };

    let socket: net.Socket;
    try {
      socket = net.createConnection({ host, port });
    } catch (error: unknown) {
      return resolve({
        host,
        port,
        open: false,
        error: error instanceof Error ? error.message : "échec de la connexion",
        ms: Date.now() - started,
      });
    }

    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => done({ error: "délai dépassé — port filtré ou fermé" }));
    socket.on("error", () => done({ error: "connexion refusée ou inaccessible" }));
    socket.on("connect", () => {
      if (!readBanner) return done({ open: true });
      // give the peer a moment to send its greeting
      setTimeout(() => done({ open: true, banner: buf.trim().split("\n")[0] || undefined }), 1500);
    });

    let buf = "";
    socket.on("data", (d) => {
      buf += d.toString("utf8");
    });
  });
}

/** Resolve through the server's configured recursive resolver. */
export async function resolveDnsRecords(name: string, type: DnsRecordType): Promise<string[]> {
  switch (type) {
    case "A":
      return dns.resolve4(name);
    case "AAAA":
      return dns.resolve6(name);
    case "MX":
      return (await dns.resolveMx(name)).map(
        ({ priority, exchange }) => `${priority} ${exchange.replace(/\.$/, "").toLowerCase()}`,
      );
    case "TXT":
      return (await dns.resolveTxt(name)).map((chunks) => chunks.join(""));
  }
}
