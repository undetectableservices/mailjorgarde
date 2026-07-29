# Install and operate JorgardeMail

JorgardeMail is self-hosted at runtime: PostgreSQL, authentication, the data
API, web application, internal direct messages, and the receive-only SMTP
service run on your Linux host. Mail and account data stay in your database.

It is not an offline appliance. Internet delivery still depends on public DNS
(or a DDNS provider), your router and ISP, and other mail servers. Installation
also pulls container images and packages. Optional `public-web` mode uses a
public certificate authority for the website.

## What this deployment does

- Receives internet email for any number of domains registered by an admin.
- Gives users mailboxes and internal direct messages through one web/API origin.
- Keeps the default web endpoint bound to one explicit LAN IPv4 address.
- Publishes only TCP 25 in the default hybrid mode.
- Creates a persistent self-signed SMTP certificate for opportunistic STARTTLS.
- Stores code under `/opt`, secrets under `/etc`, TLS state under `/var/lib`,
  and verified backups under `/var/backups`.
- Starts on reboot through systemd and Docker restart policies.

This build is receive-only. It does not send email to arbitrary internet
recipients and does not expose client-submission services.

## Requirements

- A systemd-based Linux server (Debian or Ubuntu recommended) with root access.
- Docker Engine and Docker Compose v2 installed from the
  [official Docker instructions](https://docs.docker.com/engine/install/).
- OpenSSL, `ip`, `flock`, and standard GNU userland tools.
- A reserved LAN IPv4 address for this host.
- For internet receipt: a public IPv4 address that is not behind CGNAT, an ISP
  that permits inbound TCP 25, router forwarding for TCP 25, and DNS control.
- Enough disk for the database and backups. Mail storage is persistent and can
  grow; monitor free space.

The installer deliberately does not run a remote `curl | shell` Docker setup
as root and does not silently change the host firewall.

## DDNS and two domains

A changing public IP can work for receiving mail. Use one stable mail hostname,
for example `mx.your-ddns-name.example`, whose A record is updated whenever the
home IP changes. Set `MAIL_HOSTNAME` to that exact name.

For each recipient domain, publish an MX record pointing to the same mail
hostname:

```text
domain-one.example.  MX 10 mx.your-ddns-name.example.
domain-two.example.  MX 10 mx.your-ddns-name.example.
```

The MX target must be a hostname, never an IP address. Prefer a target with a
direct A record; an MX target that is itself a CNAME is non-compliant and some
senders reject it. Remove stale AAAA records unless IPv6 is deliberately routed
and firewalled. A short DDNS TTL reduces interruption after an address change;
remote servers normally retry temporary failures.

DDNS cannot solve CGNAT or an ISP-level TCP 25 block. Test the port from a truly
external network before relying on it.

## Install

Extract or clone the project, then run:

```bash
sudo ./run.sh
```

The checkout is only an update source. The installer copies an allow-listed,
root-owned release to `/opt/mailjorgarde/releases/` and atomically points
`/opt/mailjorgarde/current` at it. The checkout may be moved after a successful
install without breaking reboot startup.

The first run:

1. Verifies Docker, Compose, OpenSSL, systemd, and required host tools.
2. Creates `/etc/mailjorgarde/mailjorgarde.env` as `root:root` mode `0600`.
3. Prompts for the explicit LAN bind address and stable MX/DDNS hostname.
4. Generates database, JWT, API, webhook, and SMTP TLS credentials locally.
5. Validates Compose, builds images, applies database migrations, and waits for
   database/auth/API/web/SMTP readiness.
6. Securely prompts for the initial administrator password. The password is
   piped to the internal provisioning tool and is never saved in configuration
   or placed in command arguments.
7. Enables `mailjorgarde.service` and a daily backup timer immediately.

For a noninteractive first install, provide `ADMIN_USERNAME` and
`ADMIN_PASSWORD` only in the invoking process environment. If the password is
omitted, a strong one is generated and displayed once. Do not put it in the
server environment file.

Additional users are created by an administrator from the Users section. Open
account creation is disabled at the authentication service.

## Deployment modes

The selected mode is persisted as `INSTALL_MODE`; an update without a mode flag
keeps it.

| Command                       | Web/API exposure                               | SMTP exposure      |
| ----------------------------- | ---------------------------------------------- | ------------------ |
| `sudo ./run.sh` or `--hybrid` | one HTTP origin on `LAN_BIND_ADDRESS:WEB_PORT` | public TCP 25      |
| `sudo ./run.sh --local`       | one HTTP origin on the LAN address             | LAN-address TCP 25 |
| `sudo ./run.sh --local-https` | one private-CA HTTPS origin on the LAN address | public TCP 25      |
| `sudo ./run.sh --public-web`  | Caddy HTTPS on public TCP 80/443               | public TCP 25      |

Hybrid mode is designed for this use case: friends use the website and direct
messages on the LAN, while internet mail reaches the SMTP receiver. The web and
data API containers have no raw host ports; LAN Caddy is their only published
origin, avoiding CORS and proxy bypasses.

> **LAN HTTP warning:** keeping a socket off the WAN is not the same as
> encrypting it. In hybrid/local HTTP mode, an attacker on untrusted Wi-Fi or an
> untrusted LAN segment can observe passwords, session tokens, email, and direct
> messages. Use `--local-https` when the LAN is not fully trusted.

In local-HTTPS mode Caddy uses its private CA. Copy the CA certificate from the
running container, transfer it to each client through a trusted channel, and
add it to that device's trust store:

```bash
cd /opt/mailjorgarde/current
sudo docker compose --project-name mailjorgarde \
  --env-file /etc/mailjorgarde/mailjorgarde.env \
  -f docker-compose.yml -f docker-compose.local-https.yml \
  cp caddy-lan:/data/caddy/pki/authorities/local/root.crt \
  /var/lib/mailjorgarde/jorgardemail-lan-root.crt
```

Trusting a private root certificate is security-sensitive; verify its checksum
out of band and install it only on devices that should access this service.

In `public-web` mode, both `WEB_HOSTNAME` DNS and public TCP 80/443 must reach
the server for website certificate issuance and renewal. That mode intentionally
makes the login surface internet-reachable.

### Firewall/router matrix

| Mode        | Router forwarding   | Host binding                              |
| ----------- | ------------------- | ----------------------------------------- |
| hybrid      | TCP 25 only         | web/API on the selected LAN IPv4          |
| local       | none                | web/API and SMTP on the selected LAN IPv4 |
| local-https | TCP 25 only         | web/API on the selected LAN IPv4          |
| public-web  | TCP 25, 80, and 443 | website and SMTP on public binds          |

Docker-published ports can bypass simplistic UFW rules. The installer enforces
the LAN bind at the socket mapping but leaves firewall policy to the operator.
Do not configure router forwards beyond the selected mode.

## SMTP encryption

The installer creates:

```text
/var/lib/mailjorgarde/tls/smtp.crt
/var/lib/mailjorgarde/tls/smtp.key
```

The private key is readable only by root and the SMTP container's numeric
group; it is never world-readable. This enables opportunistic encryption
immediately, but a self-signed certificate does not prove public identity.
Receipt is not blocked when a peer does not negotiate TLS.

For a publicly trusted SMTP identity, obtain a certificate for
`MAIL_HOSTNAME` with a DNS-01 client, atomically replace those two files, remove
`.self-signed-by-mailjorgarde`, and restart the SMTP container or service. The
SMTP process also watches certificate changes. Do not expose the LAN website
merely to solve SMTP certificate issuance.

## First application setup

1. Open the URL printed by the installer and sign in with the provisioned admin.
2. Create the friend's account in Admin → Users and share its one-time password
   through a separate secure channel.
3. Add both recipient domains in Admin → Domains.
4. Create at least one mailbox for each intended address.
5. Publish each domain's MX record to `MAIL_HOSTNAME`.
6. Send a real message from an unrelated provider and verify it arrives.

## Service and reboot behavior

`mailjorgarde.service` is enabled and started during installation. It is a
systemd oneshot controller that runs Compose with `--wait`; Docker's
`unless-stopped` policies recover individual container crashes. On reboot,
Docker starts first, then systemd reconciles the fixed Compose project and waits
for health checks. A failed readiness check makes the unit fail instead of
reporting a false success.

```bash
systemctl status mailjorgarde
systemctl restart mailjorgarde
systemctl status mailjorgarde-backup.timer
sudo /opt/mailjorgarde/current/run.sh --doctor
```

The temporary-mail cleanup worker calls the database expiry function every
minute and restarts automatically. Container JSON logs are capped at five 10 MiB
files per service.

## Backups and restore

A persistent systemd timer creates a custom-format PostgreSQL dump, a protected
copy of the configuration, and SHA-256 checksums every day. The default
retention is 14 days. Because the configuration contains the keys needed to
open the existing database and validate sessions, protect it like the dump and
copy backups to another machine.

Create one now:

```bash
sudo /opt/mailjorgarde/current/run.sh --backup
```

Before updates and destructive removal, the installer creates and validates a
fresh backup automatically when an existing database is present.

To restore, first verify the manifest and make another snapshot. Then stop the
service, restore the matching protected `.env` copy to
`/etc/mailjorgarde/mailjorgarde.env` with mode `0600`, start only PostgreSQL,
and feed the dump to `pg_restore`:

```bash
cd /var/backups/mailjorgarde
sha256sum -c mailjorgarde-TIMESTAMP.sha256
sudo systemctl stop mailjorgarde
cd /opt/mailjorgarde/current
sudo docker compose --project-name mailjorgarde \
  --env-file /etc/mailjorgarde/mailjorgarde.env \
  -f docker-compose.yml up -d db
sudo docker compose --project-name mailjorgarde \
  --env-file /etc/mailjorgarde/mailjorgarde.env \
  -f docker-compose.yml exec -T db \
  pg_restore --clean --if-exists --exit-on-error -U postgres -d postgres \
  < /var/backups/mailjorgarde/mailjorgarde-TIMESTAMP.dump
sudo systemctl start mailjorgarde
sudo /opt/mailjorgarde/current/run.sh --doctor
```

Test this procedure on a disposable host before treating backups as proven.

## Update, removal, and data safety

From a fresh checkout of the new code:

```bash
sudo ./run.sh --rebuild
```

The new release is copied under `/opt`; the persisted mode is retained and a
verified pre-update backup is taken. If installation fails, the `current`
symlink is restored to the previous code release. Database migrations are not
automatically reversed, which is why the pre-update dump matters.

If the very first installation fails, keep `/etc/mailjorgarde/mailjorgarde.env`
and the `mailjorgarde_db_data` volume. Fix or update the checkout, then retry:

```bash
sudo git pull --ff-only
sudo ./run.sh --rebuild
```

Every retry reconciles the database roles, passwords, auth-schema ownership,
and existing helper ownership before GoTrue starts, without replacing the SQL
bodies managed by GoTrue's migrations. Failed first-install containers are
removed automatically, while named volumes and private configuration remain
available for recovery.

Stop and remove the systemd units/containers while retaining all recoverable
state:

```bash
sudo /opt/mailjorgarde/current/run.sh --uninstall
```

Permanently remove the explicitly named database/proxy volumes:

```bash
sudo /opt/mailjorgarde/current/run.sh --destroy
```

Destroy requires an exact typed confirmation and a successful fresh backup.
Only an operator intentionally passing both `--skip-backup` and the explicit
noninteractive confirmation flag can bypass that safeguard. Configuration,
TLS files, backups, and installed releases remain available for recovery.

## Operational caveats

- Residential connections can change address, block TCP 25, or use CGNAT.
- A DDNS updater is provider-specific and is not installed automatically.
- The self-signed SMTP certificate provides encryption, not public identity.
- Incoming mail is resource-limited and stored safely, but this release does
  not include spam scoring, SPF/DKIM/DMARC verdicts, or antivirus scanning.
  Treat attachments as untrusted and add a dedicated mail filter if needed.
- Direct messages are access-controlled in the database, not end-to-end
  encrypted; a host or database administrator can read them.
- This is a small private receive service, not a complete enterprise mail
  gateway; monitor abuse, disk usage, database growth, and logs.
- Keep `/etc/mailjorgarde/mailjorgarde.env` and off-host backups secret.
