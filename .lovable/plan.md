## Current production architecture

JorgardeMail is a small-group, self-hosted, receive-only mail and internal
messaging application. Lovable may preview or synchronize the source tree, but
the production runtime has no Lovable Cloud dependency.

The supported stack is:

- TanStack Start web application on an internal Docker network;
- local GoTrue authentication and PostgREST API;
- PostgreSQL with RLS, quotas, and atomic inbound delivery;
- an inbound-only Node SMTP edge on host TCP 25;
- Caddy as the single browser-facing origin;
- a cleanup worker for temporary mailboxes;
- systemd for reboot reconciliation and daily verified backups.

## Exposure model

The default `hybrid` installation publishes the web/API origin on one explicit
LAN IPv4 address and publishes only SMTP TCP 25 to the Internet. Optional
`local`, `local-https`, and `public-web` modes are documented in `INSTALL.md`.
No IMAP, POP, SMTP AUTH, outbound submission, or arbitrary Internet sending is
implemented.

The SMTP edge validates recipients before DATA and acknowledges a message only
after the signed internal webhook commits all recipient copies and attachments
atomically. Resource limits, rate limits, non-root execution, storage quotas,
and readiness checks are enforced across both services.

## Product surface

- administrator-provisioned local accounts; public signup is disabled;
- multiple recipient domains and mailboxes, including required `postmaster`
  and `abuse` aliases;
- unified and per-mailbox inbox views, folders, search, safe HTML isolation,
  raw-source viewing, and attachment downloads;
- database-private direct-message threads with polling;
- account preferences and password changes;
- administrator controls for users, domains, mailbox quotas, expiry, and
  internal announcements;
- an honest DNS/port/readiness setup wizard.

## Deployment source of truth

`run.sh`, `docker-compose.yml`, its mode overlays, `selfhost/db/schema/`, and
`INSTALL.md` are the deployment contract. Installation copies an allow-listed
release to `/opt/mailjorgarde`, stores configuration in `/etc/mailjorgarde`,
keeps TLS state in `/var/lib/mailjorgarde`, and writes backups to
`/var/backups/mailjorgarde`.

Future schema changes must be new ordered migrations; never edit an already
deployed migration and expect it to rerun. Do not reintroduce magic admin
usernames, public signup, unsigned SMTP webhooks, direct browser access to the
inbound hook, or hosted production dependencies.
