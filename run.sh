#!/usr/bin/env bash
# JorgardeMail production installer and service controller.
#
# The safe default is hybrid mode:
#   * one web/API origin bound to an explicit LAN IPv4 address
#   * inbound SMTP published on TCP 25
#   * optional outbound delivery through an authenticated SMTP relay
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
warn() { printf '\033[1;33mAVERTISSEMENT :\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERREUR :\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<'EOF'
Installateur JorgardeMail

  sudo ./run.sh                    installer/mettre à jour en mode hybride par défaut
  sudo ./run.sh --rebuild          reconstruire avec des images neuves, sans cache
  sudo ./run.sh --hybrid           web/API privé + réception publique TCP 25 (défaut)
  sudo ./run.sh --local            web/API privé + TCP 25 limité au réseau privé
  sudo ./run.sh --local-https      HTTPS privé + réception publique TCP 25
  sudo ./run.sh --public-web       web/API HTTPS public + réception publique TCP 25
  sudo ./run.sh --backup           créer et vérifier une sauvegarde
  sudo ./run.sh --doctor           vérifier les services et leurs points de contrôle
  sudo ./run.sh --uninstall        arrêter les services en conservant données/configuration
  sudo ./run.sh --destroy          sauvegarder puis supprimer les volumes de données nommés

Le mode choisi est conservé. `--rebuild` sans mode garde le mode installé.
La destruction exige de saisir `DELETE mailjorgarde` ; en mode non interactif,
ajoutez `--yes-i-really-mean-it`. N’utilisez `--skip-backup` que si la base ne
peut plus démarrer et que la perte définitive est volontaire.

L’installateur exige Docker Engine, Docker Compose v2, OpenSSL et systemd.
Il ne télécharge jamais de script privilégié. Si Docker manque, installez-le
depuis https://docs.docker.com/engine/install/ puis relancez cette commande.
EOF
}

set_action() {
  local requested="$1"
  if [[ "$ACTION" != "install" && "$ACTION" != "$requested" ]]; then
    die "Choisissez une seule action (${ACTION} et ${requested} ont été demandées)."
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
    *) die "Option inconnue : $1 (utilisez --help)" ;;
  esac
  shift
done

[[ $EUID -eq 0 ]] || die "Exécutez cet installateur en tant que root : sudo ./run.sh"

acquire_lock() {
  [[ "${MAILJORGARDE_LOCK_HELD:-0}" == "1" ]] && return 0
  have flock || die "flock est requis (normalement fourni par util-linux)."
  install -d -m 0755 /run/lock
  exec 9>/run/lock/mailjorgarde-installer.lock
  flock -n 9 || die "Une autre installation, sauvegarde ou suppression JorgardeMail est en cours."
  export MAILJORGARDE_LOCK_HELD=1
}

preflight_docker() {
  have docker || die "Docker Engine manque. Installez-le depuis https://docs.docker.com/engine/install/ puis relancez."
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 manque. Installez l’extension Compose officielle."
  if ! docker info >/dev/null 2>&1; then
    if have systemctl; then systemctl start docker.service >/dev/null 2>&1 || true; fi
    docker info >/dev/null 2>&1 || die "Le service Docker ne fonctionne pas ou reste inaccessible."
  fi
  local compose_up_help
  compose_up_help="$(docker compose up --help 2>&1)"
  grep -q -- '--wait' <<<"$compose_up_help" \
    || die "Docker Compose est trop ancien ; la commande 'compose up --wait' doit être prise en charge."
}

preflight_full() {
  local command
  for command in openssl install cp mktemp mv ln readlink awk grep sed date find sha256sum ip systemctl; do
    have "$command" || die "La commande requise '$command' est absente."
  done
  [[ -d /run/systemd/system ]] || die "Un système Linux avec systemd est requis pour garantir le redémarrage automatique."
  preflight_docker
}

prepare_fixed_config() {
  install -d -m 0755 "$CONFIG_DIR"
  if [[ ! -f "$ENV_FILE" ]]; then
    local source_env="${SOURCE_DIR}/.env.example"
    if [[ -f "${SOURCE_DIR}/.env" ]] && grep -qE '^POSTGRES_PASSWORD=.{24,}$' "${SOURCE_DIR}/.env"; then
      [[ ! -L "${SOURCE_DIR}/.env" ]] || die "Import d’un fichier .env symbolique refusé."
      source_env="${SOURCE_DIR}/.env"
      log "Migration du fichier .env existant vers ${ENV_FILE}"
    else
      if [[ -f "${SOURCE_DIR}/.env" ]]; then
        warn "Le fichier .env du dépôt est ignoré, car sa configuration serveur est incomplète."
      fi
      log "Création de la configuration privée dans ${ENV_FILE}"
    fi
    [[ -f "$source_env" ]] || die "Le fichier .env.example manque dans ${SOURCE_DIR}."
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
    [[ -e "${SOURCE_DIR}/${entry}" ]] || die "La source de cette version ne contient pas ${entry}."
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
    warn "La nouvelle version a échoué ; restauration du lien vers la version précédente."
    if [[ -n "$old_target" ]]; then
      temp_link="${INSTALL_ROOT}/.rollback.$$"
      ln -s "$old_target" "$temp_link"
      mv -Tf "$temp_link" "$CURRENT_LINK"
      systemctl restart "${SERVICE_NAME}.service" >/dev/null 2>&1 \
        || warn "Le lien précédent est restauré, mais le service doit être redémarré manuellement."
    else
      log "Suppression des conteneurs de l’installation échouée (les données sont conservées)"
      /bin/bash "${destination}/run.sh" --installed-run --failed-install-cleanup \
        || warn "Certains conteneurs en échec n’ont pas été supprimés ; la prochaine installation les réconciliera."
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
      die "Les actions internes du service doivent partir de ${CURRENT_LINK}."
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
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "Clé de configuration invalide : $key"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "Une valeur de configuration ne peut pas contenir de retour à la ligne."
  [[ ! -L "$ENV_FILE" ]] || die "Modification d’un fichier de configuration symbolique refusée."
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
  MODE="$(normalize_mode "$MODE")" || die "INSTALL_MODE n’est pas pris en charge dans ${ENV_FILE}."
}

PROJECT_NAME="$(get_var COMPOSE_PROJECT_NAME)"
PROJECT_NAME="${PROJECT_NAME:-$DEFAULT_PROJECT_NAME}"
[[ "$PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die "COMPOSE_PROJECT_NAME contient des caractères invalides."
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
             ANON_KEY SERVICE_ROLE_KEY INBOUND_WEBHOOK_SECRET RUNTIME_CONFIG_KEY_B64 INSTALL_MODE \
             LAN_BIND_ADDRESS WEB_HOSTNAME MAIL_HOSTNAME SMTP_BIND_ADDRESS \
             SUPABASE_PUBLIC_URL SITE_URL SMTP_TLS_DIR OUTBOUND_SMTP_ENABLED; do
    value="$(get_var "$key")"
    [[ -n "$value" ]] || missing+=("$key")
  done
  [[ ${#missing[@]} -eq 0 ]] || die "La configuration est incomplète (${missing[*]}). Restaurez ${ENV_FILE} depuis une sauvegarde."
  local outbound_enabled outbound_key outbound_value outbound_missing=()
  outbound_enabled="$(get_var OUTBOUND_SMTP_ENABLED)"
  case "$outbound_enabled" in
    true)
      for outbound_key in OUTBOUND_SMTP_HOST OUTBOUND_SMTP_PORT OUTBOUND_SMTP_SECURITY \
                          OUTBOUND_SMTP_USERNAME OUTBOUND_SMTP_PASSWORD_B64 OUTBOUND_MAX_RECIPIENTS; do
        outbound_value="$(get_var "$outbound_key")"
        [[ -n "$outbound_value" ]] || outbound_missing+=("$outbound_key")
      done
      [[ ${#outbound_missing[@]} -eq 0 ]] \
        || die "L'envoi SMTP est activé mais incomplet (${outbound_missing[*]})."
      ;;
    false) ;;
    *) die "OUTBOUND_SMTP_ENABLED doit valoir true ou false." ;;
  esac
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
    warn "Aucun fichier de configuration dans ${ENV_FILE} ; la suppression utilisera les noms par défaut."
  else
    prepare_fixed_config
  fi
fi

PROJECT_NAME="$(get_var COMPOSE_PROJECT_NAME)"
PROJECT_NAME="${PROJECT_NAME:-$DEFAULT_PROJECT_NAME}"
[[ "$PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die "COMPOSE_PROJECT_NAME contient des caractères invalides."
load_mode

validate_volume_name() {
  [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || die "Nom de volume Docker dangereux : $1"
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
    RUNTIME_CONFIG_KEY_B64="${RUNTIME_CONFIG_KEY_B64:-removal-placeholder-runtime-config-key}" \
    SUPABASE_PUBLIC_URL="${SUPABASE_PUBLIC_URL:-http://127.0.0.1:6969}" \
    SITE_URL="${SITE_URL:-http://127.0.0.1:6969}" \
    JELLYFIN_URL="${JELLYFIN_URL:-http://127.0.0.1:8096}" \
    JELLYFIN_API_KEY="${JELLYFIN_API_KEY:-removal-placeholder-api-key}" \
    INSTALL_MODE="${INSTALL_MODE:-hybrid}" LAN_BIND_ADDRESS="${LAN_BIND_ADDRESS:-127.0.0.1}" \
    WEB_HOSTNAME="${WEB_HOSTNAME:-127.0.0.1}" MAIL_HOSTNAME="${MAIL_HOSTNAME:-mail.invalid}" \
    SMTP_BIND_ADDRESS="${SMTP_BIND_ADDRESS:-127.0.0.1}" \
    SMTP_TLS_DIR="${SMTP_TLS_DIR:-/var/lib/mailjorgarde/tls}" \
    "${down[@]}" down --remove-orphans --timeout 60; then
    die "Docker Compose n’a pas pu arrêter le projet ; aucune suppression de données n’est confirmée."
  fi
  local leftovers
  leftovers="$(docker ps -aq --filter "label=com.docker.compose.project=${PROJECT_NAME}")"
  [[ -z "$leftovers" ]] || die "Des conteneurs du projet subsistent après l’arrêt : ${leftovers}"
}

if [[ "$ACTION" == "uninstall" ]]; then
  log "Arrêt et désactivation de JorgardeMail"
  disable_units
  down_all
  ok "Services supprimés. Base, configuration, TLS, sauvegardes et versions /opt sont conservés."
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
    || die "$1 doit être un entier compris entre 1 et 65535."
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
    die "${key} est requis. Définissez-le dans ${ENV_FILE} ou relancez en mode interactif."
  fi
  set_var "$key" "$value"
}

prompt_secret_value() {
  local key="$1" description="$2" required="${3:-0}" value
  value="$(get_var "$key")"
  case "$value" in
    ""|TODO|change-me*) value="" ;;
  esac
  if [[ -z "$value" && -v "$key" ]]; then value="${!key}"; fi
  if [[ -z "$value" && $NONINTERACTIVE -eq 0 && -t 0 ]]; then
    read -r -s -p "  ${description}: " value || true
    printf '\n' >&2
  fi
  if [[ -z "$value" && "$required" == "1" ]]; then
    die "${key} est requis. Définissez-le dans ${ENV_FILE} ou relancez en mode interactif."
  fi
  set_var "$key" "$value"
}

prompt_boolean() {
  local key="$1" description="$2" default="${3:-false}" value
  value="$(get_var "$key")"
  if [[ -z "$value" && -v "$key" ]]; then set_var "$key" "${!key}"; fi
  prompt_value "$key" "$description" "$default" 1
  value="$(get_var "$key")"
  value="${value,,}"
  case "$value" in
    true|yes|y|1|oui|o) value=true ;;
    false|no|n|0|non) value=false ;;
    *) die "${key} doit valoir true/false (oui/non)." ;;
  esac
  set_var "$key" "$value"
}

validate_jellyfin_url() {
  local value="$1" remainder authority lower_authority
  case "$value" in
    http://*|https://*) ;;
    *) return 1 ;;
  esac
  [[ "$value" != *[[:space:]]* && "$value" != *\?* && "$value" != *\#* ]] || return 1
  remainder="${value#*://}"
  authority="${remainder%%/*}"
  [[ -n "$authority" && "$authority" != *@* ]] || return 1
  lower_authority="$(printf '%s' "$authority" | tr '[:upper:]' '[:lower:]')"
  case "$lower_authority" in
    localhost|localhost:*|127.*|0.0.0.0|0.0.0.0:*|'[::1]'|'[::1]':*) return 1 ;;
  esac
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

ensure_runtime_config_key() {
  local value
  value="$(get_var RUNTIME_CONFIG_KEY_B64)"
  if [[ -z "$value" ]]; then
    value="$(openssl rand -base64 32 | tr -d '\r\n')"
    set_var RUNTIME_CONFIG_KEY_B64 "$value"
  fi
  [[ "$value" =~ ^[A-Za-z0-9+/]{43}=$ ]] \
    || die "RUNTIME_CONFIG_KEY_B64 doit être une clé aléatoire de 32 octets encodée en Base64. Restaurez la configuration si cette clé existait déjà."
}

detect_legacy_db_volume() {
  docker volume inspect "$DB_VOLUME_NAME" >/dev/null 2>&1 && return 0
  local raw="${MAILJORGARDE_LEGACY_PROJECT_BASENAME:-}" normalized candidate found=""
  normalized="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g')"
  local candidates=("${normalized:+${normalized}_db_data}" jorgardemail_db_data mail-jorgarde-main_db_data)
  for candidate in "${candidates[@]}"; do
    [[ -n "$candidate" && "$candidate" != "$DB_VOLUME_NAME" ]] || continue
    if docker volume inspect "$candidate" >/dev/null 2>&1; then
      [[ -z "$found" ]] || die "Plusieurs anciens volumes de base existent (${found}, ${candidate}) ; définissez DB_VOLUME_NAME explicitement."
      found="$candidate"
    fi
  done
  if [[ -n "$found" ]]; then
    warn "Réutilisation de l’ancien volume de base détecté : ${found}"
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
  prompt_value LAN_BIND_ADDRESS "Adresse IPv4 privée utilisée par l’interface web" "$lan_default" 1
  lan="$(get_var LAN_BIND_ADDRESS)"
  is_ipv4 "$lan" || die "LAN_BIND_ADDRESS doit être une adresse IPv4 attribuée à ce serveur."
  [[ "$lan" != "0.0.0.0" && "$lan" != 127.* ]] || die "LAN_BIND_ADDRESS ne peut être ni générique ni locale à la machine."
  assigned_addresses="$(ip -o -4 addr show | awk '{split($4, address, "/"); print address[1]}')"
  grep -Fxq "$lan" <<<"$assigned_addresses" \
    || die "LAN_BIND_ADDRESS ${lan} n’est pas attribuée à ce serveur. Réservez cette adresse puis réessayez."

  case "$MODE" in
    public-web)
      prompt_value WEB_HOSTNAME "Nom DNS public de l’interface web" "" 1
      prompt_value MAIL_HOSTNAME "Nom DDNS stable utilisé comme cible MX" "" 1
      prompt_value ACME_EMAIL "Adresse de contact ACME" "" 1
      ;;
    hybrid|local-https)
      prompt_value WEB_HOSTNAME "Nom DNS privé ou adresse IPv4 utilisé dans le navigateur" "$lan" 1
      prompt_value MAIL_HOSTNAME "Nom DDNS stable utilisé comme cible MX" "" 1
      ;;
    local)
      prompt_value WEB_HOSTNAME "Nom DNS privé ou adresse IPv4 utilisé dans le navigateur" "$lan" 1
      prompt_value MAIL_HOSTNAME "Nom SMTP utilisé sur le réseau privé" "mail.local" 1
      ;;
  esac

  local web_host mail_host acme web_port https_port
  web_host="$(get_var WEB_HOSTNAME)"
  mail_host="$(get_var MAIL_HOSTNAME)"
  is_host_or_ipv4 "$web_host" || die "WEB_HOSTNAME doit être une adresse IPv4 ou un nom DNS complet."
  if [[ "$MODE" == "local" ]]; then
    is_host_or_ipv4 "$mail_host" || die "MAIL_HOSTNAME doit être une adresse IPv4 ou un nom DNS complet."
  else
    is_hostname "$mail_host" || die "MAIL_HOSTNAME doit être un nom DNS/DDNS complet, pas une adresse IP."
  fi
  if [[ "$MODE" == "public-web" ]]; then
    is_hostname "$web_host" || die "Le mode public-web exige un nom DNS dans WEB_HOSTNAME."
    acme="$(get_var ACME_EMAIL)"
    [[ "$acme" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die "ACME_EMAIL n’est pas valide."
  fi

  # Jellyfin is optional at install time. Existing environment values remain a
  # compatible fallback; new deployments configure it after the administrator
  # account exists, from the authenticated administration panel.
  local jellyfin_url jellyfin_key
  jellyfin_url="$(get_var JELLYFIN_URL)"
  jellyfin_key="$(get_var JELLYFIN_API_KEY)"
  if [[ -n "$jellyfin_url" && -n "$jellyfin_key" ]]; then
    jellyfin_url="${jellyfin_url%/}"
    if validate_jellyfin_url "$jellyfin_url" \
       && [[ ${#jellyfin_key} -ge 16 && ${#jellyfin_key} -le 256 \
          && "$jellyfin_key" =~ ^[A-Za-z0-9._~-]+$ ]]; then
      set_var JELLYFIN_URL "$jellyfin_url"
      ok "Conservation de la configuration Jellyfin de l'installateur comme solution de secours"
    else
      warn "La configuration Jellyfin historique est invalide ; elle est conservée pour diagnostic, mais ne bloque plus l'installation. Corrigez-la dans le panneau administrateur."
    fi
  elif [[ -n "$jellyfin_url" || -n "$jellyfin_key" ]]; then
    warn "La configuration Jellyfin historique est incomplète et sera ignorée. Terminez-la dans le panneau administrateur."
  else
    log "Jellyfin sera configuré après l'installation dans le panneau administrateur (sur cet hôte : http://host.docker.internal:8096)."
  fi

  local outbound_enabled outbound_host outbound_port outbound_security
  local outbound_user outbound_password outbound_password_b64 outbound_limit outbound_action
  outbound_enabled="$(get_var OUTBOUND_SMTP_ENABLED)"
  if [[ $REBUILD -eq 1 && $NONINTERACTIVE -eq 0 && -t 0 ]]; then
    if [[ "$outbound_enabled" == "true" ]]; then
      read -r -p "  Relais SMTP sortant : conserver, reconfigurer ou désactiver [c/r/d] [c] : " outbound_action || true
      case "${outbound_action,,}" in
        ""|c|conserver) ;;
        r|reconfigurer)
          set_var OUTBOUND_SMTP_HOST ""
          set_var OUTBOUND_SMTP_PORT ""
          set_var OUTBOUND_SMTP_SECURITY ""
          set_var OUTBOUND_SMTP_USERNAME ""
          set_var OUTBOUND_SMTP_PASSWORD_B64 ""
          ;;
        d|desactiver|désactiver) set_var OUTBOUND_SMTP_ENABLED false ;;
        *) die "Choix SMTP invalide : utilisez c, r ou d." ;;
      esac
    elif [[ "$outbound_enabled" == "false" ]]; then
      read -r -p "  Activer maintenant l'envoi via un relais SMTP authentifié [o/N] : " outbound_action || true
      case "${outbound_action,,}" in
        o|oui|y|yes) set_var OUTBOUND_SMTP_ENABLED true ;;
        ""|n|non|no) ;;
        *) die "Répondez oui ou non pour l'activation SMTP." ;;
      esac
    fi
  fi
  prompt_boolean OUTBOUND_SMTP_ENABLED \
    "Activer l'envoi d'e-mails vers Internet via un relais SMTP authentifié (oui/non)" false
  outbound_enabled="$(get_var OUTBOUND_SMTP_ENABLED)"
  outbound_port="$(get_var OUTBOUND_SMTP_PORT)"; outbound_port="${outbound_port:-${OUTBOUND_SMTP_PORT:-587}}"
  outbound_security="$(get_var OUTBOUND_SMTP_SECURITY)"; outbound_security="${outbound_security:-${OUTBOUND_SMTP_SECURITY:-starttls}}"
  outbound_limit="$(get_var OUTBOUND_MAX_RECIPIENTS)"; outbound_limit="${outbound_limit:-${OUTBOUND_MAX_RECIPIENTS:-25}}"
  outbound_security="${outbound_security,,}"
  validate_port OUTBOUND_SMTP_PORT "$outbound_port"
  [[ "$outbound_security" == "starttls" || "$outbound_security" == "tls" ]] \
    || die "OUTBOUND_SMTP_SECURITY doit valoir starttls (port 587) ou tls (port 465)."
  [[ "$outbound_limit" =~ ^[0-9]+$ && 10#$outbound_limit -ge 1 && 10#$outbound_limit -le 50 ]] \
    || die "OUTBOUND_MAX_RECIPIENTS doit être un entier compris entre 1 et 50."
  if [[ "$outbound_enabled" == "true" ]]; then
    prompt_value OUTBOUND_SMTP_HOST "Nom d'hôte du relais SMTP" "${OUTBOUND_SMTP_HOST:-}" 1
    prompt_value OUTBOUND_SMTP_PORT \
      "Port du relais SMTP (587 pour STARTTLS, 465 pour TLS implicite)" "$outbound_port" 1
    prompt_value OUTBOUND_SMTP_SECURITY \
      "Sécurité du relais SMTP (starttls ou tls)" "$outbound_security" 1
    prompt_value OUTBOUND_SMTP_USERNAME "Identifiant du relais SMTP" "${OUTBOUND_SMTP_USERNAME:-}" 1
    outbound_password_b64="$(get_var OUTBOUND_SMTP_PASSWORD_B64)"
    if [[ -z "$outbound_password_b64" ]]; then
      outbound_password="${OUTBOUND_SMTP_PASSWORD:-}"
      if [[ -z "$outbound_password" && $NONINTERACTIVE -eq 0 && -t 0 ]]; then
        read -r -s -p "  Mot de passe ou clé API du relais (saisie masquée) : " outbound_password || true
        printf '\n' >&2
      fi
      [[ -n "$outbound_password" ]] \
        || die "OUTBOUND_SMTP_PASSWORD est requis pour activer l'envoi SMTP."
      [[ ${#outbound_password} -le 1024 && "$outbound_password" != *$'\n'* \
         && "$outbound_password" != *$'\r'* && "$outbound_password" != *[![:print:]]* ]] \
        || die "Le mot de passe SMTP doit contenir 1 à 1024 caractères imprimables sans retour à la ligne."
      outbound_password_b64="$(printf '%s' "$outbound_password" | openssl base64 -A)"
      set_var OUTBOUND_SMTP_PASSWORD_B64 "$outbound_password_b64"
      outbound_password=""
      unset OUTBOUND_SMTP_PASSWORD 2>/dev/null || true
    fi

    outbound_host="$(get_var OUTBOUND_SMTP_HOST)"
    outbound_port="$(get_var OUTBOUND_SMTP_PORT)"
    outbound_security="$(get_var OUTBOUND_SMTP_SECURITY)"; outbound_security="${outbound_security,,}"
    outbound_user="$(get_var OUTBOUND_SMTP_USERNAME)"
    outbound_password_b64="$(get_var OUTBOUND_SMTP_PASSWORD_B64)"
    is_host_or_ipv4 "$outbound_host" \
      || die "OUTBOUND_SMTP_HOST doit être un nom d'hôte complet ou une adresse IPv4."
    validate_port OUTBOUND_SMTP_PORT "$outbound_port"
    [[ "$outbound_security" == "starttls" || "$outbound_security" == "tls" ]] \
      || die "OUTBOUND_SMTP_SECURITY doit valoir starttls ou tls."
    [[ ${#outbound_user} -ge 1 && ${#outbound_user} -le 320 \
       && "$outbound_user" != *[[:space:]]* && "$outbound_user" != *$'\n'* && "$outbound_user" != *$'\r'* ]] \
      || die "OUTBOUND_SMTP_USERNAME doit contenir 1 à 320 caractères sans espace."
    [[ ${#outbound_password_b64} -ge 4 && ${#outbound_password_b64} -le 1400 \
       && $((${#outbound_password_b64} % 4)) -eq 0 \
       && "$outbound_password_b64" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] \
      || die "OUTBOUND_SMTP_PASSWORD_B64 est invalide ; reconfigurez le relais."
  else
    log "L'envoi externe reste désactivé ; relancez l'installateur après avoir obtenu les identifiants du relais."
  fi
  set_var OUTBOUND_SMTP_PORT "$outbound_port"
  set_var OUTBOUND_SMTP_SECURITY "$outbound_security"
  set_var OUTBOUND_MAX_RECIPIENTS "$outbound_limit"

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
        || die "Le nom de l’ancien projet Compose est dangereux : ${LEGACY_PROJECT_NAME}"
    else
      LEGACY_PROJECT_NAME=""
    fi
    for key in POSTGRES_PASSWORD AUTHENTICATOR_PASSWORD AUTH_ADMIN_PASSWORD JWT_SECRET \
               ANON_KEY SERVICE_ROLE_KEY INBOUND_WEBHOOK_SECRET; do
      current="$(get_var "$key")"
      [[ ${#current} -ge 24 ]] || missing+=("$key")
    done
    [[ ${#missing[@]} -eq 0 ]] || die "Le volume ${DB_VOLUME_NAME} existe, mais des identifiants manquent (${missing[*]}). Restaurez la configuration ; ces secrets ne seront pas régénérés."
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
  # Protect panel-managed secrets with a dedicated key. Generate it once and
  # retain it on rebuilds; the root-only environment backup preserves it.
  ensure_runtime_config_key

  local tls_dir
  tls_dir="$(get_var SMTP_TLS_DIR)"; tls_dir="${tls_dir:-${DEFAULT_STATE_DIR}/tls}"
  [[ "$tls_dir" == /* && "$tls_dir" != "/" && "$tls_dir" != *:* && "$tls_dir" != *[[:space:]]* ]] || die "SMTP_TLS_DIR doit être un chemin Linux absolu sûr, sans espace."
  set_var SMTP_TLS_DIR "$tls_dir"
  set_var SMTP_TLS_CERT "/smtp-certs/smtp.crt"
  set_var SMTP_TLS_KEY "/smtp-certs/smtp.key"
  local backup_dir retention
  backup_dir="$(get_var BACKUP_DIR)"; backup_dir="${backup_dir:-$DEFAULT_BACKUP_DIR}"
  [[ "$backup_dir" == /* && "$backup_dir" != "/" && "$backup_dir" != *[[:space:]]* ]] || die "BACKUP_DIR doit être un chemin Linux absolu sûr, sans espace."
  retention="$(get_var BACKUP_RETENTION_DAYS)"; retention="${retention:-14}"
  [[ "$retention" =~ ^[0-9]+$ && 10#$retention -le 3650 ]] || die "BACKUP_RETENTION_DAYS doit être compris entre 0 et 3650."
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
    openssl x509 -in "$cert" -noout >/dev/null 2>&1 || die "Le certificat SMTP personnalisé ${cert} est invalide."
    openssl pkey -in "$key" -noout >/dev/null 2>&1 || die "La clé privée SMTP ${key} est invalide."
    chown root:1000 "$cert" "$key"
    chmod 0644 "$cert"
    chmod 0640 "$key"
    ok "Conservation du certificat SMTP TLS fourni par l’administrateur"
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
  log "Génération du certificat SMTP STARTTLS auto-signé persistant pour ${mail_host}"
  temp_key="$(mktemp "${tls_dir}/.smtp-key.XXXXXX")"
  temp_cert="$(mktemp "${tls_dir}/.smtp-cert.XXXXXX")"
  if ! openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 825 \
      -subj "/CN=${mail_host}" -addext "subjectAltName=DNS:${mail_host}" \
      -keyout "$temp_key" -out "$temp_cert" >/dev/null 2>&1; then
    rm -f "$temp_key" "$temp_cert"
    die "OpenSSL n’a pas pu créer le certificat SMTP."
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
  wait_for_database || die "La base de données n’est pas devenue disponible ; aucune sauvegarde n’a été créée."

  local backup_dir retention timestamp base dump temp_dump env_copy manifest
  backup_dir="$(get_var BACKUP_DIR)"; backup_dir="${backup_dir:-$DEFAULT_BACKUP_DIR}"
  retention="$(get_var BACKUP_RETENTION_DAYS)"; retention="${retention:-14}"
  [[ "$backup_dir" == /* && "$backup_dir" != "/" ]] || die "BACKUP_DIR dangereux : ${backup_dir}"
  install -d -o root -g root -m 0700 "$backup_dir"
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  base="${backup_dir}/mailjorgarde-${timestamp}"
  dump="${base}.dump"
  temp_dump="${base}.dump.partial"
  env_copy="${base}.env"
  manifest="${base}.sha256"
  log "Création de la sauvegarde PostgreSQL ${dump}"
  if ! "${COMPOSE[@]}" exec -T db pg_dump -U postgres -d postgres --format=custom >"$temp_dump"; then
    rm -f "$temp_dump"
    die "pg_dump a échoué ; la sauvegarde incomplète a été supprimée."
  fi
  [[ -s "$temp_dump" ]] || { rm -f "$temp_dump"; die "pg_dump a produit un fichier vide."; }
  "${COMPOSE[@]}" exec -T db pg_restore --list <"$temp_dump" >/dev/null \
    || { rm -f "$temp_dump"; die "La vérification de la sauvegarde a échoué."; }
  mv -f "$temp_dump" "$dump"
  chmod 0600 "$dump"
  install -o root -g root -m 0600 "$ENV_FILE" "$env_copy"
  (cd "$backup_dir" && sha256sum "$(basename "$dump")" "$(basename "$env_copy")" >"$(basename "$manifest")")
  chmod 0600 "$manifest"
  if [[ "$retention" =~ ^[0-9]+$ && "$retention" -gt 0 ]]; then
    find "$backup_dir" -maxdepth 1 -type f -name 'mailjorgarde-*' -mtime "+${retention}" -delete
  fi
  LAST_BACKUP="$dump"
  ok "Sauvegarde vérifiée créée : ${dump}"
}

doctor_stack() {
  require_complete_config
  local failures=0 lan_bind https_port smtp_mapping mail_host mail_addresses mail_ipv4 expected_public_ip
  local outbound_enabled outbound_health
  compose_for_mode
  "${COMPOSE[@]}" ps
  "${COMPOSE[@]}" exec -T db psql -U postgres -d postgres -qtAX -c 'SELECT 1' | grep -qx 1 \
    || { warn "La requête de base de données a échoué"; failures=$((failures + 1)); }
  "${COMPOSE[@]}" exec -T db psql -U postgres -d postgres -qtAX \
    -c "SELECT to_regprocedure('public.purge_expired_mailboxes()') IS NOT NULL" | grep -qx t \
    || { warn "La fonction de nettoyage des adresses temporaires manque"; failures=$((failures + 1)); }
  "${COMPOSE[@]}" exec -T gateway wget -qO- http://127.0.0.1:8000/auth/v1/health >/dev/null \
    || { warn "Le contrôle de l’authentification/passerelle a échoué"; failures=$((failures + 1)); }
  "${COMPOSE[@]}" exec -T web wget -qO- http://127.0.0.1:6969/api/healthz >/dev/null \
    || { warn "Le service web n’est pas prêt"; failures=$((failures + 1)); }
  "${COMPOSE[@]}" exec -T smtp wget -qO- http://127.0.0.1:8080/readyz >/dev/null \
    || { warn "Le service SMTP n’est pas prêt"; failures=$((failures + 1)); }
  smtp_mapping="$("${COMPOSE[@]}" port smtp 2525 2>/dev/null || true)"
  if [[ "$smtp_mapping" == *:25 ]]; then
    ok "Le service SMTP est publié localement sur ${smtp_mapping}"
  else
    warn "Le conteneur SMTP est prêt, mais Docker ne publie pas le port TCP 25 sur l’hôte"
    failures=$((failures + 1))
  fi
  if [[ "$MODE" == "public-web" ]]; then
    "${COMPOSE[@]}" exec -T caddy caddy validate --config /etc/caddy/Caddyfile >/dev/null \
      || { warn "La configuration Caddy publique est invalide"; failures=$((failures + 1)); }
  else
    "${COMPOSE[@]}" exec -T caddy-lan caddy validate --config /etc/caddy/Caddyfile >/dev/null \
      || { warn "La configuration Caddy privée est invalide"; failures=$((failures + 1)); }
    if [[ "$MODE" == "local-https" ]]; then
      lan_bind="$(get_var LAN_BIND_ADDRESS)"
      https_port="$(get_var HTTPS_LOCAL_PORT)"; https_port="${https_port:-8443}"
      openssl s_client -connect "${lan_bind}:${https_port}" -noservername -showcerts </dev/null 2>/dev/null \
        | grep -q -- 'BEGIN CERTIFICATE' \
        || { warn "La négociation HTTPS privée a échoué"; failures=$((failures + 1)); }
    fi
  fi
  mail_host="$(get_var MAIL_HOSTNAME)"
  if have getent; then
    mail_addresses="$(getent ahostsv4 "$mail_host" 2>/dev/null \
      | awk '!seen[$1]++ { print $1 }' || true)"
    mail_ipv4="${mail_addresses%%$'\n'*}"
    if [[ -n "$mail_ipv4" ]]; then
      ok "Le DDNS ${mail_host} résout l’adresse IPv4 ${mail_ipv4}"
      expected_public_ip="$(get_var PUBLIC_IP)"
      if [[ -n "$expected_public_ip" ]] \
         && ! grep -Fxq "$expected_public_ip" <<<"$mail_addresses"; then
        warn "Le DDNS ${mail_host} ne correspond pas à PUBLIC_IP ${expected_public_ip}"
      fi
    else
      warn "MAIL_HOSTNAME (${mail_host}) ne résout actuellement aucune IPv4 ; le service SMTP accepte néanmoins les noms DNS."
    fi
  fi
  if [[ "$MODE" != "local" ]]; then
    log "L’accès public ne peut pas être prouvé depuis ce serveur. Testez ${mail_host}:25 depuis un réseau réellement extérieur."
  fi
  outbound_enabled="$(get_var OUTBOUND_SMTP_ENABLED)"
  if [[ "$outbound_enabled" == "true" ]]; then
    outbound_health="$("${COMPOSE[@]}" exec -T web sh -ec \
      'wget -qO- --post-data="" --header="x-jorgarde-doctor: ${INBOUND_WEBHOOK_SECRET}" http://127.0.0.1:6969/api/internal/outbound-health' \
      2>/dev/null || true)"
    if grep -Fq '"ok":true' <<<"$outbound_health"; then
      ok "Le relais SMTP sortant est joignable et l'authentification réussit"
    else
      warn "Échec du relais SMTP sortant : vérifiez le nom d'hôte, TLS, les identifiants et l'autorisation du domaine"
      failures=$((failures + 1))
    fi
  else
    warn "L'envoi vers Internet est désactivé ; la réception et les messages internes restent disponibles."
  fi
  [[ $failures -eq 0 ]]
}

if [[ "$ACTION" == "backup" ]]; then backup_database; exit 0; fi
if [[ "$ACTION" == "doctor" ]]; then doctor_stack || exit 1; exit 0; fi

confirm_destroy() {
  if [[ $ASSUME_DESTROY -eq 1 ]]; then return 0; fi
  [[ $NONINTERACTIVE -eq 0 && -t 0 ]] || die "La destruction non interactive exige --yes-i-really-mean-it."
  local answer
  warn "Cette action supprime définitivement le volume Docker ${DB_VOLUME_NAME}."
  read -r -p "Saisissez 'DELETE mailjorgarde' pour continuer : " answer
  [[ "$answer" == "DELETE mailjorgarde" ]] || die "Destruction annulée."
}

if [[ "$ACTION" == "destroy" ]]; then
  confirm_destroy
  if docker volume inspect "$DB_VOLUME_NAME" >/dev/null 2>&1 && [[ $SKIP_BACKUP -eq 0 ]]; then
    backup_database
  elif [[ $SKIP_BACKUP -eq 1 ]]; then
    warn "Sauvegarde de sécurité ignorée à votre demande explicite."
  fi
  disable_units
  down_all
  for volume in "$DB_VOLUME_NAME" "$CADDY_DATA_VOLUME_NAME" "$CADDY_CONFIG_VOLUME_NAME" \
                "$CADDY_LAN_DATA_VOLUME_NAME" "$CADDY_LAN_CONFIG_VOLUME_NAME"; do
    if docker volume inspect "$volume" >/dev/null 2>&1; then
      docker volume rm "$volume" >/dev/null || die "Impossible de supprimer le volume ${volume}."
    fi
  done
  ok "Volumes de base/proxy supprimés. Configuration, TLS, sauvegardes et versions /opt restent récupérables."
  exit 0
fi

configure_install
generate_smtp_certificate
compose_for_mode
"${COMPOSE[@]}" config --quiet || die "La validation de la configuration Docker Compose a échoué."

stop_legacy_project() {
  [[ -n "$LEGACY_PROJECT_NAME" ]] || return 0
  local -a containers
  mapfile -t containers < <(docker ps -aq --filter "label=com.docker.compose.project=${LEGACY_PROJECT_NAME}")
  [[ ${#containers[@]} -gt 0 ]] || return 0
  warn "Migration des conteneurs de l’ancien projet Compose ${LEGACY_PROJECT_NAME} ; les volumes sont conservés."
  docker stop --time 60 "${containers[@]}" >/dev/null \
    || die "Impossible d’arrêter tous les conteneurs de l’ancien projet."
  docker rm "${containers[@]}" >/dev/null \
    || die "Impossible de supprimer tous les anciens conteneurs arrêtés."
}

stop_legacy_project

if [[ $DB_EXISTED -eq 1 ]]; then
  log "Base existante détectée ; création d’une sauvegarde vérifiée avant mise à jour"
  backup_database
fi

if [[ $REBUILD -eq 1 ]]; then
  log "Récupération des images d’exécution actuelles"
  "${COMPOSE[@]}" pull --ignore-buildable || die "Impossible de récupérer les images d’exécution."
fi

log "Construction du service web, de la réception SMTP et de l'envoi sortant"
BUILD_FLAGS=()
[[ $REBUILD -eq 1 ]] && BUILD_FLAGS+=(--no-cache --pull)
"${COMPOSE[@]}" build "${BUILD_FLAGS[@]}" || die "La construction des images a échoué."

if [[ -n "$(docker ps -q --filter "label=com.docker.compose.project=${PROJECT_NAME}")" ]]; then
  log "Arrêt contrôlé des services avant réconciliation de la base et de l’authentification"
  "${COMPOSE[@]}" stop --timeout 60 \
    || die "Impossible d’arrêter proprement l’installation avant la mise à jour."
fi

# Compose may otherwise reuse successful one-shot containers and satisfy
# depends_on from their old exit status. Force both reconciliation jobs to run
# against this release before any long-running service starts.
"${COMPOSE[@]}" rm -sf auth-bootstrap schema-init >/dev/null \
  || die "Impossible de réinitialiser les tâches de réconciliation de la base."

log "Démarrage des services et attente de leur disponibilité"
if ! "${COMPOSE[@]}" up -d --remove-orphans --wait --wait-timeout 240; then
  "${COMPOSE[@]}" ps || true
  "${COMPOSE[@]}" logs --tail 100 auth-bootstrap schema-init auth gateway web smtp || true
  die "Les services ne sont pas devenus opérationnels ; systemd n’a pas été installé ou mis à jour."
fi

log "Validation de l'inscription privée via Jellyfin"
if ! "${COMPOSE[@]}" exec -T web node scripts/check-jellyfin.mjs; then
  warn "La configuration Jellyfin historique n'est pas utilisable. L'installation continue ; configurez et testez Jellyfin dans le panneau administrateur."
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
    || die "Impossible de vérifier l’état du compte administrateur."
  [[ "$present" == "t" ]] && { ok "Le compte administrateur existe déjà"; return 0; }

  username="${ADMIN_USERNAME:-}"
  password="${ADMIN_PASSWORD:-}"
  if [[ $NONINTERACTIVE -eq 0 && -t 0 ]]; then
    while [[ ! "$username" =~ ^[a-z0-9][a-z0-9_-]{1,22}[a-z0-9]$ ]]; do
      read -r -p "  Identifiant de l’administrateur initial [admin] : " username
      username="${username:-admin}"
      username="${username,,}"
      [[ "$username" =~ ^[a-z0-9][a-z0-9_-]{1,22}[a-z0-9]$ ]] \
        || warn "Utilisez 3 à 24 lettres minuscules, chiffres, _ ou -."
    done
    if [[ -z "$password" ]]; then
      while :; do
        read -r -s -p "  Mot de passe initial (12 à 128 caractères) : " password; echo
        read -r -s -p "  Confirmez le mot de passe : " confirm; echo
        [[ "$password" == "$confirm" ]] || { warn "Les mots de passe ne correspondent pas."; continue; }
        [[ ${#password} -ge 12 && ${#password} -le 128 && "$password" != *$'\n'* ]] \
          || { warn "Le mot de passe doit contenir 12 à 128 caractères."; continue; }
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
  [[ "$username" =~ ^[a-z0-9][a-z0-9_-]{1,22}[a-z0-9]$ ]] || die "ADMIN_USERNAME est invalide."
  [[ ${#password} -ge 12 && ${#password} -le 128 && "$password" != *$'\n'* && "$password" != *$'\r'* && "$password" != *[![:print:]]* ]] \
    || die "ADMIN_PASSWORD doit contenir 12 à 128 caractères imprimables sans retour à la ligne."
  payload="{\"username\":\"$(json_escape "$username")\",\"password\":\"$(json_escape "$password")\",\"displayName\":\"$(json_escape "$username")\"}"
  printf '%s' "$payload" | "${COMPOSE[@]}" exec -T web node scripts/provision-admin.mjs \
    || die "La création du compte administrateur initial a échoué."
  if [[ $generated -eq 1 ]]; then
    printf '\nIdentifiants administrateur générés (affichés une seule fois) :\n  identifiant : %s\n  mot de passe : %s\n\n' "$username" "$password"
    warn "Conservez ce mot de passe maintenant ; l’installateur ne l’enregistre pas."
  fi
  unset password confirm payload ADMIN_PASSWORD
}

provision_admin
doctor_stack || die "Le contrôle de santé interne a échoué ; consultez les journaux ci-dessus."

install_systemd_units() {
  local tls_mount backup_mount legacy
  tls_mount="$(get_var SMTP_TLS_DIR)"
  backup_mount="$(get_var BACKUP_DIR)"
  log "Installation du service systemd et de la sauvegarde quotidienne"
  for legacy in "${LEGACY_SERVICE_NAMES[@]}"; do
    systemctl disable --now "${legacy}.service" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/${legacy}.service"
  done
  cat >"/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Service de messagerie JorgardeMail
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
Description=Sauvegarde de la base et de la configuration JorgardeMail
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
Description=Sauvegarde quotidienne JorgardeMail

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
    || die "Impossible d’activer ou démarrer ${SERVICE_NAME}.service."
  systemctl restart "${SERVICE_NAME}.service" >/dev/null \
    || die "Le service systemd installé n’a pas pu réconcilier les services."
  systemctl enable --now "${BACKUP_SERVICE_NAME}.timer" >/dev/null \
    || die "Impossible d’activer la sauvegarde quotidienne."
  systemctl is-active --quiet "${SERVICE_NAME}.service" \
    || die "${SERVICE_NAME}.service n’est pas actif après l’installation."
}

install_systemd_units

WEB_HOST="$(get_var WEB_HOSTNAME)"
MAIL_HOST="$(get_var MAIL_HOSTNAME)"
WEB_PORT="$(get_var WEB_PORT)"
HTTPS_PORT="$(get_var HTTPS_LOCAL_PORT)"
LAN_BIND="$(get_var LAN_BIND_ADDRESS)"

echo
ok "JorgardeMail fonctionne correctement et démarrera automatiquement après un redémarrage."
case "$MODE" in
  hybrid)
    echo "  Web + API : http://${WEB_HOST}:${WEB_PORT} (liaison limitée à ${LAN_BIND})"
    echo "  Réception : ${MAIL_HOST}:25 (TCP 25 public ; STARTTLS auto-signé opportuniste)"
    ;;
  local)
    echo "  Web + API : http://${WEB_HOST}:${WEB_PORT} (liaison limitée à ${LAN_BIND})"
    echo "  Réception : ${MAIL_HOST}:25 (réseau privé ${LAN_BIND} uniquement)"
    ;;
  local-https)
    echo "  Web + API : https://${WEB_HOST}:${HTTPS_PORT} (autorité Caddy privée ; liaison ${LAN_BIND})"
    echo "  Réception : ${MAIL_HOST}:25 (TCP 25 public ; STARTTLS auto-signé opportuniste)"
    ;;
  public-web)
    echo "  Web + API : https://${WEB_HOST} (ports publics 80/443)"
    echo "  Réception : ${MAIL_HOST}:25 (TCP 25 public ; STARTTLS auto-signé opportuniste)"
    ;;
esac
if [[ "$MODE" == "hybrid" || "$MODE" == "local" ]]; then
  warn "HTTP ne chiffre pas mots de passe, sessions, e-mails ou messages sur Wi-Fi/Ethernet."
  warn "Utilisez --local-https hors d’un réseau WireGuard entièrement maîtrisé."
fi
echo
echo "Pour chaque domaine reçu, ajoutez-le dans l'administration et pointez son MX vers ${MAIL_HOST}."
echo "L'enregistrement A DDNS de ${MAIL_HOST} doit suivre cette connexion, et le routeur/FAI"
echo "doit autoriser le port TCP 25 entrant. Un nom DDNS convient : aucune adresse IP littérale n'est requise."
if [[ "$(get_var OUTBOUND_SMTP_ENABLED)" == "true" ]]; then
  echo "L'envoi externe utilise le relais authentifié $(get_var OUTBOUND_SMTP_HOST):$(get_var OUTBOUND_SMTP_PORT)."
  echo "Publiez les enregistrements SPF et DKIM du relais ainsi qu'une politique DMARC pour chaque domaine expéditeur."
else
  echo "L'envoi vers Internet est prêt mais désactivé. Relancez l'installateur avec les identifiants du relais SMTP."
fi
echo
echo "Commandes utiles :"
echo "  systemctl status ${SERVICE_NAME}"
echo "  systemctl restart ${SERVICE_NAME}"
echo "  sudo ${CURRENT_LINK}/run.sh --backup"
echo "  sudo ${CURRENT_LINK}/run.sh --doctor"
echo "  ${COMPOSE[*]} logs -f web smtp"
echo
