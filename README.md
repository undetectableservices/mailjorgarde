# JorgardeMail

JorgardeMail is a private mail and internal messaging service for a small
trusted group. It receives internet mail directly and can send through an
authenticated SMTP relay.

The production default is intentionally hybrid:

- web UI, authentication, API, and direct messages share one LAN-bound origin;
- internet email enters through TCP 25;
- outgoing internet email leaves through a TLS-protected authenticated relay;
- application data and credentials stay on the host;
- friend registration is gated by an exact, password-verified Jellyfin account;
- systemd and Docker restart the service after reboot or container failure.

A dynamic public IP can work with a correctly maintained DDNS A record and MX
records for both recipient domains, provided the connection is not behind
CGNAT and the ISP permits inbound TCP 25.

Install on a systemd-based Linux host:

```bash
sudo ./run.sh
```

The installer copies a root-owned release to `/opt/mailjorgarde`, writes private
configuration under `/etc/mailjorgarde`, provisions the initial administrator,
waits for real readiness checks, enables reboot startup, and schedules verified
daily backups.

See [INSTALL.md](INSTALL.md) for DNS/DDNS requirements, deployment modes,
firewall bindings, service behavior, backup/restore, updates, and limitations.

For local source development only:

```bash
bun install --frozen-lockfile
bun run dev
```

The repository may remain connected to Lovable for source synchronization; the
production runtime does not depend on or contact Lovable. Do not rewrite
published Git history on its connected branch.
