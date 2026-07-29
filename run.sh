#!/usr/bin/env bash
# JorgardeMail production installer and service controller.
#
# The safe default is hybrid mode:
#   * one web/API origin bound to an explicit LAN IPv4 address
#   * inbound SMTP published on TCP 25
#   * receive-only SMTP with no client-submission ports
set -Eeuo pipefail
umask 077

SERVICE_NAME="mailjorgarde"
BACKUP_SERVICE_NAME="mailjorgarde-backup"
LEGACY_SERVICE_NAMES=("jorgardemail")
INSTALL_ROOT="/opt/mailjorgarde"
CURRENT_LINK="${INSTALL_ROOT}/current"
RELEASES_DIR="${INSTALL_ROOT}/releases"
CONFIG_DIR="/etc/mailjorgarde"
ENV_FILE="${CONFIG_DIR}/mailjorgarde.env"
DEFAULT_STATE_DIR="/var/lib/mailjorgarde"
DEFAULT_BACKUP_DIR="/var/backups/mailjorgarde"
DEFAULT_PROJECT_NAME="mailjorgarde"
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd -P)"
ORIGINAL_ARGS=("$@")

ACTION="install"
MODE_OVERRIDE=""
REBUILD=0
ASSUME_DESTROY=0
SKIP_BACKUP=0
NONINTERACTIVE=0
INSTALLED_RUN=0
LEGACY_PROJECT_NAME=""

log()  { printf '\033[1;33m>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32mOK\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARNING:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<'EOF'
JorgardeMail installer

  sudo ./run.sh                    install/update; new installs use hybrid mode
  sudo ./run.sh --rebuild          update with fresh images and no build cache
  sudo ./run.sh --hybrid           LAN web/API + public inbound TCP 25 (default)
  sudo ./run.sh --local            LAN web/API + LAN-only TCP 25
  sudo ./run.sh --local-https      private-CA LAN HTTPS + public inbound TCP 25
  sudo ./run.sh --public-web       public HTTPS web/API + public inbound TCP 25
  sudo ./run.sh --backup           create and verify a database/config backup
  sudo ./run.sh --doctor           check container and internal endpoint health
  sudo ./run.sh --uninstall        stop/remove services; retain config and data
  sudo ./run.sh --destroy          back up, stop, and delete named data volumes

Mode is persisted. `--rebuild` without a mode keeps the installed mode.
Destroy requires typing `DELETE mailjorgarde`; noninteractive use additionally
`--yes-i-really-mean-it`. Use `--skip-backup` only if the database cannot start
and permanent loss is intentional.

The installer requires Docker Engine, Docker Compose v2, OpenSSL, and systemd.
It never downloads or pipes a privileged installation script. If Docker is
missing, install it from https://docs.docker.com/engine/install/ and rerun.
EOF
}

set_action() {
  local requested="$1"
  if [[ "$ACTION" != "install" && "$ACTION" != "$requested" ]]; then
    die "Choose only one action (requested both ${ACTION} and ${requested})."
  fi
  ACTION="$requested"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hybrid) MODE_OVERRIDE="hybrid" ;;
    --local) MODE_OVERRIDE="local" ;;
    --local-https) MODE_OVERRIDE="local-https" ;;
    --public|--public-web) MODE_OVERRIDE="public-web" ;;
    --rebuild) REBUILD=1 ;;
    --backup) set_action backup ;;
    --doctor) set_action doctor ;;
    --uninstall) set_action uninstall ;;
    --destroy) set_action destroy ;;
    --yes-i-really-mean-it) ASSUME_DESTROY=1 ;;
    --skip-backup) SKIP_BACKUP=1 ;;
    --non-interactive) NONINTERACTIVE=1 ;;
    --installed-run) INSTALLED_RUN=1 ;;
    --service-start) set_action service-start ;;
    --service-stop) set_action service-stop ;;
    --failed-install-cleanup) set_action failed-install-cleanup ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (use --help)" ;;
  esac
  shift
done

[[ $EUID -eq 0 ]] || die "Run this installer as root: sudo ./run.sh"

acquire_lock() {
  [[ "${MAILJORGARDE_LOCK_HELD:-0}" == "1" ]] && return 0
  have flock || die "flock is required (normally provided by util-linux)."
  install -d -m 0755 /run/lock
  exec 9>/run/lock/mailjorgarde-installer.lock
  flock -n 9 || die "Another JorgardeMail install, backup, or removal is running."
  export MAILJORGARDE_LOCK_HELD=1
}

preflight_docker() {
  have docker || die "Docker Engine is missing. Install it from https://docs.docker.com/engine/install/ and rerun."
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing. Install the official compose plugin."
  if ! docker info >/dev/null 2>&1; then
    if have systemctl; then systemctl start docker.service >/dev/null 2>&1 || true; fi
    docker info >/dev/null 2>&1 || die "The Docker daemon is not running or is not reachable."
  fi
  local compose_up_help
  compose_up_help="$(docker compose up --help 2>&1)"
  grep -q -- '--wait' <<<"$compose_up_help" \
    || die "Docker Compose is too old; a version supporting 'compose up --wait' is required."
}

preflight_full() {
  local command
  for command in openssl install cp mktemp mv ln readlink awk grep sed date find sha256sum ip systemctl; do
    have "$command" || die "Required command '$command' is missing."
  done
  [[ -d /run/systemd/system ]] || die "A systemd-based Linux host is required for reliable reboot startup."
  preflight_docker
}

prepare_fixed_config() {
  install -d -m 0755 "$CONFIG_DIR"
  if [[ ! -f "$ENV_FILE" ]]; then
    local source_env="${SOURCE_DIR}/.env.example"
    if [[ -f "${SOURCE_DIR}/.env" ]] && grep -qE '^POSTGRES_PASSWORD=.{24,}$' "${SOURCE_DIR}/.env"; then
      [[ ! -L "${SOURCE_DIR}/.env" ]] || die "Refusing to import a symlinked .env file."
      source_env="${SOURCE_DIR}/.env"
      log "Migrating the checkout's existing .env into ${ENV_FILE}"
    else
      if [[ -f "${SOURCE_DIR}/.env" ]]; then
        warn "Ignoring the checkout .env because it is not a complete self-hosted server config."
      fi
      log "Creating private configuration at ${ENV_FILE}"
    fi
    [[ -f "$source_env" ]] || die "Missing .env.example in ${SOURCE_DIR}."
    install -o root -g root -m 0600 "$source_env" "$ENV_FILE"
  fi
  chown root:root "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
}

copy_release_and_run() {
  preflight_full
  acquire_lock
  prepare_fixed_config

  install -d -o root -g root -m 0755 "$INSTALL_ROOT" "$RELEASES_DIR"
  local release_id destination old_target temp_link rc
  release_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  destination="${RELEASES_DIR}/${release_id}"
  install -d -o root -g root -m 0755 "$destination"

  local entries=(
    public selfhost services src supabase scripts
    .dockerignore .env.example .gitignore
    bun.lock bunfig.toml Caddyfile Caddyfile.lan Caddyfile.lan-https
    components.json docker-compose.yml docker-compose.local.yml
    docker-compose.local-https.yml Dockerfile eslint.config.js INSTALL.md
    install.sh package.json README.md run.sh tsconfig.json vite.config.ts
  )
  local entry
  for entry in "${entries[@]}"; do
    [[ -e "${SOURCE_DIR}/${entry}" ]] || die "Release source is missing ${entry}."
    cp -a -- "${SOURCE_DIR}/${entry}" "$destination/"
  done
  chown -R root:root "$destination"
  chmod 0755 "$destination/run.sh" "$destination/install.sh"

  old_target="$(readlink "$CURRENT_LINK" 2>/dev/null || true)"
  temp_link="${INSTALL_ROOT}/.current.$$"
  ln -s "$destination" "$temp_link"
  mv -Tf "$temp_link" "$CURRENT_LINK"

  export MAILJORGARDE_LEGACY_PROJECT_BASENAME
  MAILJORGARDE_LEGACY_PROJECT_BASENAME="$(basename "$SOURCE_DIR")"
  set +e
  /bin/bash "${CURRENT_LINK}/run.sh" --installed-run "${ORIGINAL_ARGS[@]}"
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then
    warn "The new release failed; restoring the previous /opt release link."
    if [[ -n "$old_target" ]]; then
      temp_link="${INSTALL_ROOT}/.rollback.$$"
      ln -s "$old_target" "$temp_link"
      mv -Tf "$temp_link" "$CURRENT_LINK"
      systemctl restart "${SERVICE_NAME}.service" >/dev/null 2>&1 \
        || warn "Previous release link was restored, but its service needs a manual restart."
    else
      log "Removing containers from the failed first installation (persistent data is retained)"
      /bin/bash "${destination}/run.sh" --installed-run --failed-install-cleanup \
        || warn "Failed containers could not be removed; the next installation will still reconcile them."
      systemctl disable --now "${SERVICE_NAME}.service" >/dev/null 2>&1 || true
      systemctl disable --now "${BACKUP_SERVICE_NAME}.timer" >/dev/null 2>&1 || true
      unlink "$CURRENT_LINK" 2>/dev/null || true
    fi
    exit "$rc"
  fi
  exit 0
}

# User actions run from a checkout are copied to a stable, root-owned release.
# Operational actions delegate to the installed release and never create one.
if [[ $INSTALLED_RUN -eq 0 ]]; then
  case "$ACTION" in
    install) copy_release_and_run ;;
    backup|doctor|uninstall|destroy)
      if [[ -x "${CURRENT_LINK}/run.sh" ]]; then
        exec /bin/bash "${CURRENT_LINK}/run.sh" --installed-run "${ORIGINAL_ARGS[@]}"
      fi
      # Support removing a pre-hardening deployment that still runs here.
      ENV_FILE="${SOURCE_DIR}/.env"
      ;;
    service-start|service-stop|failed-install-cleanup)
      die "Internal service actions must run from ${CURRENT_LINK}."
      ;;
  esac
fi

APP_DIR="$SOURCE_DIR"
cd "$APP_DIR"

get_var() {
  local key="$1" file="${2:-$ENV_FILE}" line
  [[ -f "$file" ]] || return 0
  line="$(grep -m1 -E "^${key}=" "$file" 2>/dev/null || true)"
  line="${line#*=}"
  printf '%s' "${line%$'\r'}"
}

set_var() {
  local key="$1" value="$2" temp line found=0
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "Invalid configuration key: $key"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "Configuration values may not contain newlines."
  [[ ! -L "$ENV_FILE" ]] || die "Refusing to edit a symlinked configuration file."
  temp="$(mktemp "${ENV_FILE}.tmp.XXXXXX")"
  chmod 0600 "$temp"
  if [[ -f "$ENV_FILE" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" == "${key}="* ]]; then
        if [[ $found -eq 0 ]]; then printf '%s=%s\n' "$key" "$value" >>"$temp"; fi
        found=1
      else
        printf '%s\n' "$line" >>"$temp"
      fi
    done <"$ENV_FILE"
  fi
  if [[ $found -eq 0 ]]; then printf '%s=%s\n' "$key" "$value" >>"$temp"; fi
  chown root:root "$temp"
  mv -f "$temp" "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
}

normalize_mode() {
  case "$1" in
    hybrid) printf hybrid ;;
    local|local-http) printf local ;;
    local-https) printf local-https ;;
    public|public-web) printf public-web ;;
    "") return 1 ;;
    *) return 2 ;;
  esac
}

load_mode() {
  local stored inferred site
  stored="$(get_var INSTALL_MODE)"
  if [[ -n "$MODE_OVERRIDE" ]]; then
    MODE="$MODE_OVERRIDE"
  elif MODE="$(normalize_mode "$stored" 2>/dev/null)"; then
    :
  else
    site="$(get_var SITE_URL)"
    case "$site" in
      https://*:8443) inferred="local-https" ;;
      https://*) inferred="public-web" ;;
      http://*) inferred="local" ;;
      *) inferred="hybrid" ;;
    esac
    MODE="$inferred"
  fi
  MODE="$(normalize_mode "$MODE")" || die "Unsupported INSTALL_MODE in ${ENV_FILE}."
}

PROJECT_NAME="$(get_var COMPOSE_PROJECT_NAME)"
PROJECT_NAME="${PROJECT_NAME:-$DEFAULT_PROJECT_NAME}"
[[ "$PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die "COMPOSE_PROJECT_NAME has invalid characters."
load_mode

compose_for_mode() {
  CARGS=(--project-name "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$APP_DIR/docker-compose.yml")
  case "$MODE" in
    hybrid|local) CARGS+=(-f "$APP_DIR/docker-compose.local.yml") ;;
    local-https) CARGS+=(-f "$APP_DIR/docker-compose.local-https.yml") ;;
    public-web) CARGS+=(--profile public-web) ;;
  esac
  COMPOSE=(docker compose "${CARGS[@]}")
}

require_complete_config() {
  local key value missing=()
  for key in POSTGRES_PASSWORD AUTHENTICATOR_PASSWORD AUTH_ADMIN_PASSWORD JWT_SECRET \
             ANON_KEY SERVICE_ROLE_KEY INBOUND_WEBHOOK_SECRET INSTALL_MODE \
             LAN_BIND_ADDRESS WEB_HOSTNAME MAIL_HOSTNAME SMTP_BIND_ADDRESS \
             SUPABASE_PUBLIC_URL SITE_URL SMTP_TLS_DIR; do
    value="$(get_var "$key")"
    [[ -n "$value" ]] || missing+=("$key")
  done
  [[ ${#missing[@]} -eq 0 ]] || die "Configuration is incomplete (${missing[*]}). Restore ${ENV_FILE} from backup."
}

service_start() {
  preflight_docker
  require_complete_config
  compose_for_mode
  "${COMPOSE[@]}" config --quiet
  "${COMPOSE[@]}" up -d --remove-orphans --wait --wait-timeout 240
}

service_stop() {
  preflight_docker
  require_complete_config
  compose_for_mode
  "${COMPOSE[@]}" stop --timeout 60
}

failed_install_cleanup() {
  preflight_docker
  require_complete_config
  compose_for_mode
  "${COMPOSE[@]}" down --remove-orphans --timeout 60
}

if [[ "$ACTION" == "service-start" ]]; then service_start; exit 0; fi
if [[ "$ACTION" == "service-stop" ]]; then service_stop; exit 0; fi
if [[ "$ACTION" == "failed-install-cleanup" ]]; then failed_install_cleanup; exit 0; fi

preflight_full
acquire_lock

if [[ ! -f "$ENV_FILE" ]]; then
  if [[ "$ACTION" == "uninstall" || "$ACTION" == "destroy" ]]; then
    warn "No configuration file exists at ${ENV_FILE}; removal will use fixed default names."
  else
    prepare_fixed_config
  fi
fi

PROJECT_NAME="$(get_var COMPOSE_PROJECT_NAME)"
PROJECT_NAME="${PROJECT_NAME:-$DEFAULT_PROJECT_NAME}"
[[ "$PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die "COMPOSE_PROJECT_NAME has invalid characters."
load_mode

validate_volume_name() {
  [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || die "Unsafe Docker volume name: $1"
}

volume_name() {
  local key="$1" fallback="$2" value
  value="$(get_var "$key")"
  printf '%s' "${value:-$fallback}"
}

DB_VOLUME_NAME="$(volume_name DB_VOLUME_NAME mailjorgarde_db_data)"
CADDY_DATA_VOLUME_NAME="$(volume_name CADDY_DATA_VOLUME_NAME mailjorgarde_caddy_data)"
CADDY_CONFIG_VOLUME_NAME="$(volume_name CADDY_CONFIG_VOLUME_NAME mailjorgarde_caddy_config)"
CADDY_LAN_DATA_VOLUME_NAME="$(volume_name CADDY_LAN_DATA_VOLUME_NAME mailjorgarde_caddy_lan_data)"
CADDY_LAN_CONFIG_VOLUME_NAME="$(volume_name CADDY_LAN_CONFIG_VOLUME_NAME mailjorgarde_caddy_lan_config)"
for volume in "$DB_VOLUME_NAME" "$CADDY_DATA_VOLUME_NAME" "$CADDY_CONFIG_VOLUME_NAME" \
              "$CADDY_LAN_DATA_VOLUME_NAME" "$CADDY_LAN_CONFIG_VOLUME_NAME"; do
  validate_volume_name "$volume"
done

disable_units() {
  systemctl disable --now "${BACKUP_SERVICE_NAME}.timer" >/dev/null 2>&1 || true
  systemctl disable --now "${SERVICE_NAME}.service" >/dev/null 2>&1 || true
  local legacy
  for legacy in "${LEGACY_SERVICE_NAMES[@]}"; do
    systemctl disable --now "${legacy}.service" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/${legacy}.service"
  done
  rm -f "/etc/systemd/system/${SERVICE_NAME}.service" \
        "/etc/systemd/system/${BACKUP_SERVICE_NAME}.service" \
        "/etc/systemd/system/${BACKUP_SERVICE_NAME}.timer"
  systemctl daemon-reload
}

down_all() {
  local env_args=()
  [[ -f "$ENV_FILE" ]] && env_args=(--env-file "$ENV_FILE")
  local down=(docker compose --project-name "$PROJECT_NAME" "${env_args[@]}"
    -f "$APP_DIR/docker-compose.yml"
    -f "$APP_DIR/docker-compose.local.yml"
    -f "$APP_DIR/docker-compose.local-https.yml"
    --profile public-web)
  if ! env \
    POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-removal-placeholder}" \
    AUTHENTICATOR_PASSWORD="${AUTHENTICATOR_PASSWORD:-removal-placeholder}" \
    AUTH_ADMIN_PASSWORD="${AUTH_ADMIN_PASSWORD:-removal-placeholder}" \
    JWT_SECRET="${JWT_SECRET:-removal-placeholder-secret-32-bytes}" \
    ANON_KEY="${ANON_KEY:-removal-placeholder}" \
    SERVICE_ROLE_KEY="${SERVICE_ROLE_KEY:-removal-placeholder}" \
    INBOUND_WEBHOOK_SECRET="${INBOUND_WEBHOOK_SECRET:-removal-placeholder-secret-32-bytes}" \
    SUPABASE_PUBLIC_URL="${SUPABASE_PUBLIC_URL:-http://127.0.0.1:6969}" \
    SITE_URL="${SITE_URL:-http://127.0.0.1:6969}" \
    INSTALL_MODE="${INSTALL_MODE:-hybrid}" LAN_BIND_ADDRESS="${LAN_BIND_ADDRESS:-127.0.0.1}" \
    WEB_HOSTNAME="${WEB_HOSTNAME:-127.0.0.1}" MAIL_HOSTNAME="${MAIL_HOSTNAME:-mail.invalid}" \
    SMTP_BIND_ADDRESS="${SMTP_BIND_ADDRESS:-127.0.0.1}" \
    SMTP_TLS_DIR="${SMTP_TLS_DIR:-/var/lib/mailjorgarde/tls}" \
    "${down[@]}" down --remove-orphans --timeout 60; then
    die "Docker Compose could not stop the project; data was not reported as removed."
  fi
  local leftovers
  leftovers="$(docker ps -aq --filter "label=com.docker.compose.project=${PROJECT_NAME}")"
  [[ -z "$leftovers" ]] || die "Project containers remain after shutdown: ${leftovers}"
}

if [[ "$ACTION" == "uninstall" ]]; then
  log "Stopping and disabling JorgardeMail"
  disable_units
  down_all
  ok "Services removed. Database, configuration, TLS state, backups, and /opt releases were retained."
  exit 0
fi

is_ipv4() {
  local ip="$1" a b c d part
  IFS=. read -r a b c d <<<"$ip"
  [[ -n "${a:-}" && -n "${b:-}" && -n "${c:-}" && -n "${d:-}" ]] || return 1
  [[ "$ip" != *.*.*.*.* ]] || return 1
  for part in "$a" "$b" "$c" "$d"; do
    [[ "$part" =~ ^[0-9]+$ && 10#$part -le 255 ]] || return 1
  done
}

is_hostname() {
  local host="$1" label
  local -a labels
  [[ ${#host} -le 253 && "$host" == *.* && "$host" != *..* ]] || return 1
  IFS=. read -ra labels <<<"$host"
  for label in "${labels[@]}"; do
    [[ ${#label} -ge 1 && ${#label} -le 63 ]] || return 1
    [[ "$label" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]] || return 1
  done
}

is_host_or_ipv4() { is_ipv4 "$1" || is_hostname "$1"; }

validate_port() {
  [[ "$2" =~ ^[0-9]+$ && 10#$2 -ge 1 && 10#$2 -le 65535 ]] \
    || die "$1 must be an integer from 1 to 65535."
}

detect_lan_ip() {
  ip -4 route get 1.1.1.1 2>/dev/null \
    | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}'
}

prompt_value() {
  local key="$1" description="$2" default="${3:-}" required="${4:-0}" value
  value="$(get_var "$key")"
  case "$value" in
    ""|TODO|change-me*|192.168.1.10|*example.com) value="" ;;
  esac
  if [[ -z "$value" && $NONINTERACTIVE -eq 0 && -t 0 ]]; then
    read -r -p "  ${description}${default:+ [${default}]}: " value || true
  fi
  value="${value:-$default}"
  if [[ -z "$value" && "$required" == "1" ]]; then
    die "${key} is required. Set it in ${ENV_FILE} or rerun interactively."
  fi
  set_var "$key" "$value"
}

rand_pw() { openssl rand -hex 24; }
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

mint_jwt() {
  local role="$1" secret="$2" iat exp header payload signing signature
  iat="$(date +%s)"
  exp=$((iat + 60 * 60 * 24 * 365 * 10))
  header='{"alg":"HS256","typ":"JWT"}'
  payload="{\"role\":\"${role}\",\"iss\":\"jorgardemail\",\"iat\":${iat},\"exp\":${exp}}"
  signing="$(printf '%s' "$header" | b64url).$(printf '%s' "$payload" | b64url)"
  signature="$(printf '%s' "$signing" | openssl dgst -sha256 -hmac "$secret" -binary | b64url)"
  printf '%s.%s' "$signing" "$signature"
}

ensure_secret() {
  local key="$1" minimum="$2" value
  value="$(get_var "$key")"
  if [[ ${#value} -lt $minimum ]]; then set_var "$key" "$(rand_pw)"; fi
}

detect_legacy_db_volume() {
  docker volume inspect "$DB_VOLUME_NAME" >/dev/null 2>&1 && return 0
  local raw="${MAILJORGARDE_LEGACY_PROJECT_BASENAME:-}" normalized candidate found=""
  normalized="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g')"
  local candidates=("${normalized:+${normalized}_db_data}" jorgardemail_db_data mail-jorgarde-main_db_data)
  for candidate in "${candidates[@]}"; do
    [[ -n "$candidate" && "$candidate" != "$DB_VOLUME_NAME" ]] || continue
    if docker volume inspect "$candidate" >/dev/null 2>&1; then
      [[ -z "$found" ]] || die "Multiple legacy database volumes exist (${found}, ${candidate}); set DB_VOLUME_NAME explicitly."
      found="$candidate"
    fi
  done
  if [[ -n "$found" ]]; then
    warn "Reusing detected legacy database volume: ${found}"
    DB_VOLUME_NAME="$found"
    set_var DB_VOLUME_NAME "$found"
  fi
}

configure_install() {
  install -d -m 0755 "$CONFIG_DIR"
  [[ -f "$ENV_FILE" ]] || install -o root -g root -m 0600 "$APP_DIR/.env.example" "$ENV_FILE"

  set_var COMPOSE_PROJECT_NAME "$DEFAULT_PROJECT_NAME"
  PROJECT_NAME="$DEFAULT_PROJECT_NAME"
  if [[ -n "$MODE_OVERRIDE" ]]; then MODE="$MODE_OVERRIDE"; fi
  set_var INSTALL_MODE "$MODE"

  DB_VOLUME_NAME="$(volume_name DB_VOLUME_NAME mailjorgarde_db_data)"
  detect_legacy_db_volume
  set_var DB_VOLUME_NAME "$DB_VOLUME_NAME"
  set_var CADDY_DATA_VOLUME_NAME "$CADDY_DATA_VOLUME_NAME"
  set_var CADDY_CONFIG_VOLUME_NAME "$CADDY_CONFIG_VOLUME_NAME"
  set_var CADDY_LAN_DATA_VOLUME_NAME "$CADDY_LAN_DATA_VOLUME_NAME"
  set_var CADDY_LAN_CONFIG_VOLUME_NAME "$CADDY_LAN_CONFIG_VOLUME_NAME"

  local lan_default lan current assigned_addresses
  lan_default="$(detect_lan_ip || true)"
  prompt_value LAN_BIND_ADDRESS "LAN IPv4 address to bind the web UI" "$lan_default" 1
  lan="$(get_var LAN_BIND_ADDRESS)"
  is_ipv4 "$lan" || die "LAN_BIND_ADDRESS must be an IPv4 address assigned to this host."
  [[ "$lan" != "0.0.0.0" && "$lan" != 127.* ]] || die "LAN_BIND_ADDRESS may not be wildcard or loopback."
  assigned_addresses="$(ip -o -4 addr show | awk '{split($4, address, "/"); print address[1]}')"
  grep -Fxq "$lan" <<<"$assigned_addresses" \
    || die "LAN_BIND_ADDRESS ${lan} is not currently assigned to this host. Reserve this LAN address and retry."

  case "$MODE" in
    public-web)
      prompt_value WEB_HOSTNAME "public web hostname" "" 1
      prompt_value MAIL_HOSTNAME "stable MX/DDNS hostname" "" 1
      prompt_value ACME_EMAIL "ACME contact email" "" 1
      ;;
    hybrid|local-https)
      prompt_value WEB_HOSTNAME "dotted LAN hostname or IPv4 used in the browser" "$lan" 1
      prompt_value MAIL_HOSTNAME "stable MX/DDNS hostname" "" 1
      ;;
    local)
      prompt_value WEB_HOSTNAME "dotted LAN hostname or IPv4 used in the browser" "$lan" 1
      prompt_value MAIL_HOSTNAME "SMTP hostname on the LAN" "mail.local" 1
      ;;
  esac

  local web_host mail_host acme web_port https_port
  web_host="$(get_var WEB_HOSTNAME)"
  mail_host="$(get_var MAIL_HOSTNAME)"
  is_host_or_ipv4 "$web_host" || die "WEB_HOSTNAME must be an IPv4 address or dotted DNS hostname."
  if [[ "$MODE" == "local" ]]; then
    is_host_or_ipv4 "$mail_host" || die "MAIL_HOSTNAME must be an IPv4 address or dotted DNS hostname."
  else
    is_hostname "$mail_host" || die "MAIL_HOSTNAME must be a dotted DNS/DDNS hostname, not an IP address."
  fi
  if [[ "$MODE" == "public-web" ]]; then
    is_hostname "$web_host" || die "public-web mode requires a DNS hostname for WEB_HOSTNAME."
    acme="$(get_var ACME_EMAIL)"
    [[ "$acme" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die "ACME_EMAIL is not valid."
  fi

  web_port="$(get_var WEB_PORT)"; web_port="${web_port:-6969}"
  https_port="$(get_var HTTPS_LOCAL_PORT)"; https_port="${https_port:-8443}"
  validate_port WEB_PORT "$web_port"
  validate_port HTTPS_LOCAL_PORT "$https_port"
  set_var WEB_PORT "$web_port"
  set_var HTTPS_LOCAL_PORT "$https_port"

  case "$MODE" in
    public-web)
      set_var SITE_URL "https://${web_host}"
      set_var SUPABASE_PUBLIC_URL "https://${web_host}"
      set_var SMTP_BIND_ADDRESS "0.0.0.0"
      ;;
    local-https)
      set_var SITE_URL "https://${web_host}:${https_port}"
      set_var SUPABASE_PUBLIC_URL "https://${web_host}:${https_port}"
      set_var SMTP_BIND_ADDRESS "0.0.0.0"
      ;;
    hybrid)
      set_var SITE_URL "http://${web_host}:${web_port}"
      set_var SUPABASE_PUBLIC_URL "http://${web_host}:${web_port}"
      set_var SMTP_BIND_ADDRESS "0.0.0.0"
      ;;
    local)
      set_var SITE_URL "http://${web_host}:${web_port}"
      set_var SUPABASE_PUBLIC_URL "http://${web_host}:${web_port}"
      set_var SMTP_BIND_ADDRESS "$lan"
      ;;
  esac
  set_var PUBLIC_BIND_ADDRESS "$(get_var PUBLIC_BIND_ADDRESS | sed 's/^$/0.0.0.0/')"

  local db_exists=0 key missing=()
  docker volume inspect "$DB_VOLUME_NAME" >/dev/null 2>&1 && db_exists=1
  DB_EXISTED="$db_exists"
  if [[ $db_exists -eq 1 ]]; then
    LEGACY_PROJECT_NAME="$(docker volume inspect --format '{{ index .Labels "com.docker.compose.project" }}' "$DB_VOLUME_NAME" 2>/dev/null || true)"
    if [[ -z "$LEGACY_PROJECT_NAME" && "$DB_VOLUME_NAME" == *_db_data ]]; then
      LEGACY_PROJECT_NAME="${DB_VOLUME_NAME%_db_data}"
    fi
    if [[ -n "$LEGACY_PROJECT_NAME" && "$LEGACY_PROJECT_NAME" != "$PROJECT_NAME" ]]; then
      [[ "$LEGACY_PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]*$ ]] \
        || die "Legacy Compose project label is unsafe: ${LEGACY_PROJECT_NAME}"
    else
      LEGACY_PROJECT_NAME=""
    fi
    for key in POSTGRES_PASSWORD AUTHENTICATOR_PASSWORD AUTH_ADMIN_PASSWORD JWT_SECRET \
               ANON_KEY SERVICE_ROLE_KEY INBOUND_WEBHOOK_SECRET; do
      current="$(get_var "$key")"
      [[ ${#current} -ge 24 ]] || missing+=("$key")
    done
    [[ ${#missing[@]} -eq 0 ]] || die "Existing database volume ${DB_VOLUME_NAME} found, but credentials are missing (${missing[*]}). Restore the config backup; credentials will not be regenerated."
  else
    ensure_secret POSTGRES_PASSWORD 24
    ensure_secret AUTHENTICATOR_PASSWORD 24
    ensure_secret AUTH_ADMIN_PASSWORD 24
    local jwt
    jwt="$(get_var JWT_SECRET)"
    if [[ ${#jwt} -lt 32 ]]; then
      jwt="$(openssl rand -hex 32)"
      set_var JWT_SECRET "$jwt"
      set_var ANON_KEY ""
      set_var SERVICE_ROLE_KEY ""
    fi
    # A fresh database has no compatibility constraint: always issue a
    # matching pair so stale hosted/project keys cannot leak into self-hosting.
    set_var ANON_KEY "$(mint_jwt anon "$jwt")"
    set_var SERVICE_ROLE_KEY "$(mint_jwt service_role "$jwt")"
    ensure_secret INBOUND_WEBHOOK_SECRET 32
  fi

  local tls_dir
  tls_dir="$(get_var SMTP_TLS_DIR)"; tls_dir="${tls_dir:-${DEFAULT_STATE_DIR}/tls}"
  [[ "$tls_dir" == /* && "$tls_dir" != "/" && "$tls_dir" != *:* && "$tls_dir" != *[[:space:]]* ]] || die "SMTP_TLS_DIR must be a safe absolute Linux path without spaces."
  set_var SMTP_TLS_DIR "$tls_dir"
  set_var SMTP_TLS_CERT "/smtp-certs/smtp.crt"
  set_var SMTP_TLS_KEY "/smtp-certs/smtp.key"
  local backup_dir retention
  backup_dir="$(get_var BACKUP_DIR)"; backup_dir="${backup_dir:-$DEFAULT_BACKUP_DIR}"
  [[ "$backup_dir" == /* && "$backup_dir" != "/" && "$backup_dir" != *[[:space:]]* ]] || die "BACKUP_DIR must be a safe absolute Linux path without spaces."
  retention="$(get_var BACKUP_RETENTION_DAYS)"; retention="${retention:-14}"
  [[ "$retention" =~ ^[0-9]+$ && 10#$retention -le 3650 ]] || die "BACKUP_RETENTION_DAYS must be 0-3650."
  set_var BACKUP_DIR "$backup_dir"
  set_var BACKUP_RETENTION_DAYS "$retention"
  chmod 0600 "$ENV_FILE"
}

generate_smtp_certificate() {
  local tls_dir mail_host cert key marker regenerate=0 temp_key temp_cert
  tls_dir="$(get_var SMTP_TLS_DIR)"
  mail_host="$(get_var MAIL_HOSTNAME)"
  cert="${tls_dir}/smtp.crt"
  key="${tls_dir}/smtp.key"
  marker="${tls_dir}/.self-signed-by-mailjorgarde"
  # The SMTP image runs as node (GID 1000). Keep the key unavailable to
  # everyone else while granting that container group read/traverse access.
  install -d -o root -g 1000 -m 0750 "$tls_dir"
  if [[ -f "$cert" && -f "$key" && ! -f "$marker" ]]; then
    openssl x509 -in "$cert" -noout >/dev/null 2>&1 || die "Custom SMTP certificate ${cert} is invalid."
    openssl pkey -in "$key" -noout >/dev/null 2>&1 || die "Custom SMTP private key ${key} is invalid."
    chown root:1000 "$cert" "$key"
    chmod 0644 "$cert"
    chmod 0640 "$key"
    ok "Preserving operator-managed SMTP TLS certificate"
    return 0
  fi
  if [[ ! -f "$cert" || ! -f "$key" ]]; then
    regenerate=1
  elif ! openssl x509 -in "$cert" -noout -checkend 2592000 >/dev/null 2>&1; then
    regenerate=1
  elif ! openssl x509 -in "$cert" -noout -ext subjectAltName 2>/dev/null | grep -Fq "DNS:${mail_host}"; then
    regenerate=1
  fi
  [[ $regenerate -eq 1 ]] || return 0
  log "Generating persistent self-signed SMTP STARTTLS certificate for ${mail_host}"
  temp_key="$(mktemp "${tls_dir}/.smtp-key.XXXXXX")"
  temp_cert="$(mktemp "${tls_dir}/.smtp-cert.XXXXXX")"
  if ! openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 825 \
      -subj "/CN=${mail_host}" -addext "subjectAltName=DNS:${mail_host}" \
      -keyout "$temp_key" -out "$temp_cert" >/dev/null 2>&1; then
    rm -f "$temp_key" "$temp_cert"
    die "OpenSSL could not create the SMTP certificate."
  fi
  install -o root -g 1000 -m 0640 "$temp_key" "$key"
  install -o root -g 1000 -m 0644 "$temp_cert" "$cert"
  rm -f "$temp_key" "$temp_cert"
  : >"$marker"
  chmod 0600 "$marker"
}

wait_for_database() {
  local attempt
  for attempt in $(seq 1 60); do
    if "${COMPOSE[@]}" exec -T db pg_isready -U postgres -d postgres >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

backup_database() {
  require_complete_config
  compose_for_mode
  "${COMPOSE[@]}" up -d db >/dev/null
  wait_for_database || die "Database did not become ready; no backup was created."

  local backup_dir retention timestamp base dump temp_dump env_copy manifest
  backup_dir="$(get_var BACKUP_DIR)"; backup_dir="${backup_dir:-$DEFAULT_BACKUP_DIR}"
  retention="$(get_var BACKUP_RETENTION_DAYS)"; retention="${retention:-14}"
  [[ "$backup_dir" == /* && "$backup_dir" != "/" ]] || die "Unsafe BACKUP_DIR: ${backup_dir}"
  install -d -o root -g root -m 0700 "$backup_dir"
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  base="${backup_dir}/mailjorgarde-${timestamp}"
  dump="${base}.dump"
  temp_dump="${base}.dump.partial"
  env_copy="${base}.env"
  manifest="${base}.sha256"
  log "Creating PostgreSQL backup ${dump}"
  if ! "${COMPOSE[@]}" exec -T db pg_dump -U postgres -d postgres --format=custom >"$temp_dump"; then
    rm -f "$temp_dump"
    die "pg_dump failed; the incomplete backup was removed."
  fi
  [[ -s "$temp_dump" ]] || { rm -f "$temp_dump"; die "pg_dump produced an empty file."; }
  "${COMPOSE[@]}" exec -T db pg_restore --list <"$temp_dump" >/dev/null \
    || { rm -f "$temp_dump"; die "Backup verification failed."; }
  mv -f "$temp_dump" "$dump"
  chmod 0600 "$dump"
  install -o root -g root -m 0600 "$ENV_FILE" "$env_copy"
  (cd "$backup_dir" && sha256sum "$(basename "$dump")" "$(basename "$env_copy")" >"$(basename "$manifest")")
  chmod 0600 "$manifest"
  if [[ "$retention" =~ ^[0-9]+$ && "$retention" -gt 0 ]]; then
    find "$backup_dir" -maxdepth 1 -type f -name 'mailjorgarde-*' -mtime "+${retention}" -delete
  fi
  LAST_BACKUP="$dump"
  ok "Verified backup created: ${dump}"
}

doctor_stack() {
  require_complete_config
  local failures=0 lan_bind https_port
  compose_for_mode
  "${COMPOSE[@]}" ps
  "${COMPOSE[@]}" exec -T db psql -U postgres -d postgres -qtAX -c 'SELECT 1' | grep -qx 1 \
    || { warn "Database query failed"; failures=$((failures + 1)); }
  "${COMPOSE[@]}" exec -T db psql -U postgres -d postgres -qtAX \
    -c "SELECT to_regprocedure('public.purge_expired_mailboxes()') IS NOT NULL" | grep -qx t \
    || { warn "Temporary-mail cleanup function is missing"; failures=$((failures + 1)); }
  "${COMPOSE[@]}" exec -T gateway wget -qO- http://127.0.0.1:8000/auth/v1/health >/dev/null \
    || { warn "Auth/gateway health failed"; failures=$((failures + 1)); }
  "${COMPOSE[@]}" exec -T web wget -qO- http://127.0.0.1:6969/api/healthz >/dev/null \
    || { warn "Web readiness failed"; failures=$((failures + 1)); }
  "${COMPOSE[@]}" exec -T smtp wget -qO- http://127.0.0.1:8080/readyz >/dev/null \
    || { warn "SMTP readiness failed"; failures=$((failures + 1)); }
  if [[ "$MODE" == "public-web" ]]; then
    "${COMPOSE[@]}" exec -T caddy caddy validate --config /etc/caddy/Caddyfile >/dev/null \
      || { warn "Public Caddy configuration failed validation"; failures=$((failures + 1)); }
  else
    "${COMPOSE[@]}" exec -T caddy-lan caddy validate --config /etc/caddy/Caddyfile >/dev/null \
      || { warn "LAN Caddy configuration failed validation"; failures=$((failures + 1)); }
    if [[ "$MODE" == "local-https" ]]; then
      lan_bind="$(get_var LAN_BIND_ADDRESS)"
      https_port="$(get_var HTTPS_LOCAL_PORT)"; https_port="${https_port:-8443}"
      openssl s_client -connect "${lan_bind}:${https_port}" -noservername -showcerts </dev/null 2>/dev/null \
        | grep -q -- 'BEGIN CERTIFICATE' \
        || { warn "LAN HTTPS handshake failed"; failures=$((failures + 1)); }
    fi
  fi
  if have getent; then
    local mail_host
    mail_host="$(get_var MAIL_HOSTNAME)"
    getent ahostsv4 "$mail_host" >/dev/null 2>&1 \
      || warn "MAIL_HOSTNAME (${mail_host}) does not currently resolve to IPv4; update DDNS before expecting internet delivery."
  fi
  [[ $failures -eq 0 ]]
}

if [[ "$ACTION" == "backup" ]]; then backup_database; exit 0; fi
if [[ "$ACTION" == "doctor" ]]; then doctor_stack || exit 1; exit 0; fi

confirm_destroy() {
  if [[ $ASSUME_DESTROY -eq 1 ]]; then return 0; fi
  [[ $NONINTERACTIVE -eq 0 && -t 0 ]] || die "Noninteractive destroy requires --yes-i-really-mean-it."
  local answer
  warn "This permanently deletes Docker volume ${DB_VOLUME_NAME}."
  read -r -p "Type 'DELETE mailjorgarde' to continue: " answer
  [[ "$answer" == "DELETE mailjorgarde" ]] || die "Destroy cancelled."
}

if [[ "$ACTION" == "destroy" ]]; then
  confirm_destroy
  if docker volume inspect "$DB_VOLUME_NAME" >/dev/null 2>&1 && [[ $SKIP_BACKUP -eq 0 ]]; then
    backup_database
  elif [[ $SKIP_BACKUP -eq 1 ]]; then
    warn "Skipping the safety backup by explicit request."
  fi
  disable_units
  down_all
  for volume in "$DB_VOLUME_NAME" "$CADDY_DATA_VOLUME_NAME" "$CADDY_CONFIG_VOLUME_NAME" \
                "$CADDY_LAN_DATA_VOLUME_NAME" "$CADDY_LAN_CONFIG_VOLUME_NAME"; do
    if docker volume inspect "$volume" >/dev/null 2>&1; then
      docker volume rm "$volume" >/dev/null || die "Could not delete volume ${volume}."
    fi
  done
  ok "Named database/proxy volumes deleted. Config, TLS files, backups, and /opt releases remain recoverable."
  exit 0
fi

configure_install
generate_smtp_certificate
compose_for_mode
"${COMPOSE[@]}" config --quiet || die "Docker Compose configuration validation failed."

stop_legacy_project() {
  [[ -n "$LEGACY_PROJECT_NAME" ]] || return 0
  local -a containers
  mapfile -t containers < <(docker ps -aq --filter "label=com.docker.compose.project=${LEGACY_PROJECT_NAME}")
  [[ ${#containers[@]} -gt 0 ]] || return 0
  warn "Migrating containers from legacy Compose project ${LEGACY_PROJECT_NAME}; named volumes are retained."
  docker stop --time 60 "${containers[@]}" >/dev/null \
    || die "Could not stop every legacy project container."
  docker rm "${containers[@]}" >/dev/null \
    || die "Could not remove every stopped legacy project container."
}

stop_legacy_project

if [[ $DB_EXISTED -eq 1 ]]; then
  log "Existing database detected; taking a verified pre-update backup"
  backup_database
fi

if [[ $REBUILD -eq 1 ]]; then
  log "Pulling current runtime images"
  "${COMPOSE[@]}" pull --ignore-buildable || die "Could not pull runtime images."
fi

log "Building the web and inbound SMTP images"
BUILD_FLAGS=()
[[ $REBUILD -eq 1 ]] && BUILD_FLAGS+=(--no-cache --pull)
"${COMPOSE[@]}" build "${BUILD_FLAGS[@]}" || die "Image build failed."

if [[ -n "$(docker ps -q --filter "label=com.docker.compose.project=${PROJECT_NAME}")" ]]; then
  log "Quiescing the existing stack before database/auth reconciliation"
  "${COMPOSE[@]}" stop --timeout 60 \
    || die "Could not stop the existing stack cleanly before the update."
fi

# Compose may otherwise reuse successful one-shot containers and satisfy
# depends_on from their old exit status. Force both reconciliation jobs to run
# against this release before any long-running service starts.
"${COMPOSE[@]}" rm -sf auth-bootstrap schema-init >/dev/null \
  || die "Could not reset the database reconciliation jobs."

log "Starting the stack and waiting for readiness"
if ! "${COMPOSE[@]}" up -d --remove-orphans --wait --wait-timeout 240; then
  "${COMPOSE[@]}" ps || true
  "${COMPOSE[@]}" logs --tail 100 auth-bootstrap schema-init auth gateway web smtp || true
  die "The stack did not become healthy; systemd was not installed/updated."
fi

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\t'/\\t}"
  printf '%s' "$value"
}

provision_admin() {
  local present username password confirm generated=0 payload
  present="$("${COMPOSE[@]}" exec -T db psql -U postgres -d postgres -qtAX \
    -c "SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE role::text = 'admin');")" \
    || die "Could not inspect administrator state."
  [[ "$present" == "t" ]] && { ok "Administrator already provisioned"; return 0; }

  username="${ADMIN_USERNAME:-}"
  password="${ADMIN_PASSWORD:-}"
  if [[ $NONINTERACTIVE -eq 0 && -t 0 ]]; then
    while [[ ! "$username" =~ ^[a-z0-9][a-z0-9_-]{1,22}[a-z0-9]$ ]]; do
      read -r -p "  Initial admin username [admin]: " username
      username="${username:-admin}"
      username="${username,,}"
      [[ "$username" =~ ^[a-z0-9][a-z0-9_-]{1,22}[a-z0-9]$ ]] \
        || warn "Use 3-24 lowercase letters, digits, underscore, or hyphen."
    done
    if [[ -z "$password" ]]; then
      while :; do
        read -r -s -p "  Initial admin password (12-128 characters): " password; echo
        read -r -s -p "  Confirm admin password: " confirm; echo
        [[ "$password" == "$confirm" ]] || { warn "Passwords did not match."; continue; }
        [[ ${#password} -ge 12 && ${#password} -le 128 && "$password" != *$'\n'* ]] \
          || { warn "Password must be 12-128 characters."; continue; }
        break
      done
    fi
  else
    username="${username:-admin}"
    if [[ -z "$password" ]]; then
      password="$(openssl rand -base64 30 | tr -d '\r\n')"
      generated=1
    fi
  fi
  username="${username,,}"
  [[ "$username" =~ ^[a-z0-9][a-z0-9_-]{1,22}[a-z0-9]$ ]] || die "ADMIN_USERNAME is invalid."
  [[ ${#password} -ge 12 && ${#password} -le 128 && "$password" != *$'\n'* && "$password" != *$'\r'* && "$password" != *[![:print:]]* ]] \
    || die "ADMIN_PASSWORD must be 12-128 printable characters without newlines."
  payload="{\"username\":\"$(json_escape "$username")\",\"password\":\"$(json_escape "$password")\",\"displayName\":\"$(json_escape "$username")\"}"
  printf '%s' "$payload" | "${COMPOSE[@]}" exec -T web node scripts/provision-admin.mjs \
    || die "Initial administrator provisioning failed."
  if [[ $generated -eq 1 ]]; then
    printf '\nGenerated administrator credentials (shown once):\n  username: %s\n  password: %s\n\n' "$username" "$password"
    warn "Store this password now; it is not saved by the installer."
  fi
  unset password confirm payload ADMIN_PASSWORD
}

provision_admin
doctor_stack || die "Internal health verification failed; inspect the logs above."

install_systemd_units() {
  local tls_mount backup_mount legacy
  tls_mount="$(get_var SMTP_TLS_DIR)"
  backup_mount="$(get_var BACKUP_DIR)"
  log "Installing systemd service and daily backup timer"
  for legacy in "${LEGACY_SERVICE_NAMES[@]}"; do
    systemctl disable --now "${legacy}.service" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/${legacy}.service"
  done
  cat >"/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=JorgardeMail self-hosted mail stack
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target
RequiresMountsFor=${INSTALL_ROOT} ${CONFIG_DIR} ${tls_mount}
ConditionPathExists=${ENV_FILE}

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${CURRENT_LINK}
ExecStart=/bin/bash ${CURRENT_LINK}/run.sh --installed-run --service-start
ExecReload=/bin/bash ${CURRENT_LINK}/run.sh --installed-run --service-start
ExecStop=/bin/bash ${CURRENT_LINK}/run.sh --installed-run --service-stop
TimeoutStartSec=300
TimeoutStopSec=90
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

  cat >"/etc/systemd/system/${BACKUP_SERVICE_NAME}.service" <<EOF
[Unit]
Description=Back up JorgardeMail database and private configuration
Requires=docker.service
After=docker.service ${SERVICE_NAME}.service
RequiresMountsFor=${backup_mount}

[Service]
Type=oneshot
ExecCondition=/usr/bin/systemctl is-active --quiet ${SERVICE_NAME}.service
ExecStart=/bin/bash ${CURRENT_LINK}/run.sh --installed-run --backup --non-interactive
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
EOF

  cat >"/etc/systemd/system/${BACKUP_SERVICE_NAME}.timer" <<EOF
[Unit]
Description=Daily JorgardeMail backup

[Timer]
OnCalendar=daily
RandomizedDelaySec=30m
Persistent=true
Unit=${BACKUP_SERVICE_NAME}.service

[Install]
WantedBy=timers.target
EOF
  chmod 0644 "/etc/systemd/system/${SERVICE_NAME}.service" \
    "/etc/systemd/system/${BACKUP_SERVICE_NAME}.service" \
    "/etc/systemd/system/${BACKUP_SERVICE_NAME}.timer"
  systemctl daemon-reload
  systemctl enable --now docker.service >/dev/null
  systemctl enable --now "${SERVICE_NAME}.service" >/dev/null \
    || die "Could not enable/start ${SERVICE_NAME}.service."
  systemctl restart "${SERVICE_NAME}.service" >/dev/null \
    || die "The installed systemd service could not reconcile the healthy stack."
  systemctl enable --now "${BACKUP_SERVICE_NAME}.timer" >/dev/null \
    || die "Could not enable the daily backup timer."
  systemctl is-active --quiet "${SERVICE_NAME}.service" \
    || die "${SERVICE_NAME}.service is not active after installation."
}

install_systemd_units

WEB_HOST="$(get_var WEB_HOSTNAME)"
MAIL_HOST="$(get_var MAIL_HOSTNAME)"
WEB_PORT="$(get_var WEB_PORT)"
HTTPS_PORT="$(get_var HTTPS_LOCAL_PORT)"
LAN_BIND="$(get_var LAN_BIND_ADDRESS)"

echo
ok "JorgardeMail is healthy and enabled for automatic reboot startup."
case "$MODE" in
  hybrid)
    echo "  Web + API: http://${WEB_HOST}:${WEB_PORT} (host bind ${LAN_BIND} only)"
    echo "  Inbound:   ${MAIL_HOST}:25 (public TCP 25; opportunistic self-signed STARTTLS)"
    ;;
  local)
    echo "  Web + API: http://${WEB_HOST}:${WEB_PORT} (host bind ${LAN_BIND} only)"
    echo "  Inbound:   ${MAIL_HOST}:25 (LAN bind ${LAN_BIND} only)"
    ;;
  local-https)
    echo "  Web + API: https://${WEB_HOST}:${HTTPS_PORT} (private Caddy CA; LAN bind ${LAN_BIND})"
    echo "  Inbound:   ${MAIL_HOST}:25 (public TCP 25; opportunistic self-signed STARTTLS)"
    ;;
  public-web)
    echo "  Web + API: https://${WEB_HOST} (public ports 80/443)"
    echo "  Inbound:   ${MAIL_HOST}:25 (public TCP 25; opportunistic self-signed STARTTLS)"
    ;;
esac
if [[ "$MODE" == "hybrid" || "$MODE" == "local" ]]; then
  warn "LAN HTTP does not encrypt passwords, session tokens, mail, or DMs on Wi-Fi/Ethernet."
  warn "Use --local-https and trust Caddy's local CA unless every LAN segment is trusted."
fi
echo
echo "For each recipient domain, add it in Admin and set its MX record to ${MAIL_HOST}."
echo "The DDNS A record for ${MAIL_HOST} must track this connection, and your router/ISP"
echo "must permit inbound TCP 25. This is a receive-only SMTP service."
echo
echo "Operations:"
echo "  systemctl status ${SERVICE_NAME}"
echo "  systemctl restart ${SERVICE_NAME}"
echo "  sudo ${CURRENT_LINK}/run.sh --backup"
echo "  sudo ${CURRENT_LINK}/run.sh --doctor"
echo "  ${COMPOSE[*]} logs -f web smtp"
echo
