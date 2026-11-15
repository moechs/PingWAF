#!/usr/bin/env bash
# PingWAF Docker Compose installer.
#
#   curl -fsSL https://raw.githubusercontent.com/shuaiZend/PingWAF/main/deploy/compose/install.sh | bash
#
# Downloads the official compose file into ./pingwaf, writes a private .env with
# the values below, then runs `docker compose up -d`. It never needs root and
# never overwrites an existing .env: a second run is an upgrade, not a reset.
set -euo pipefail

REPO="${PINGWAF_REPO:-shuaiZend/PingWAF}"
REF="${PINGWAF_REF:-}"
TAG="${PINGWAF_TAG:-latest}"
DIR="${PINGWAF_COMPOSE_DIR:-pingwaf}"
ADMIN_EMAIL="${PINGWAF_ADMIN_EMAIL:-admin@pingwaf.local}"
# No built-in default password: an empty value is replaced below by a random
# password, printed exactly once (or reused from an existing .env on --force).
ADMIN_PASSWORD="${PINGWAF_ADMIN_PASSWORD:-}"
# Instance key that seals notification/AI/backup credentials at rest. It is
# generated once into .env and must never be rotated silently: previously
# sealed credentials cannot be opened with a new key.
PINGWAF_SECRET_KEY="${PINGWAF_SECRET_KEY:-}"
ADMIN_PASSWORD_GENERATED=false
TLS_SANS="${PINGWAF_TLS_SANS:-}"
HTTP_PORT="${PINGWAF_HTTP_PORT:-80}"
HTTPS_PORT="${PINGWAF_HTTPS_PORT:-443}"
ADMIN_PORT="${PINGWAF_ADMIN_PORT:-9080}"
GRPC_PORT="${PINGWAF_GRPC_PORT:-9090}"
FORCE=false
DRY_RUN=false

usage() {
    cat <<'EOF'
PingWAF Docker Compose installer

Usage:
  install.sh [options]

Options:
  --tag <tag>              Image tag (default: the newest GitHub release tag,
                           resolved through the API; never the moving `main`)
  --ref <git-ref>          Git ref the compose file is downloaded from
                           (default: v<tag>; `main` must be requested explicitly
                           and is only for development)
  --dir <path>             Directory to create/use (default: ./pingwaf)
  --admin-email <email>    Initial administrator e-mail
  --admin-password <pw>    Initial administrator password (default: a random
                           password generated once and printed at the end)
  --tls-sans <list>        Comma-separated SANs for the self-signed dashboard cert
  --http-port <port>       Host port for HTTP (default: 80)
  --https-port <port>      Host port for HTTPS (default: 443)
  --admin-port <port>      Host port for the console/API (default: 9080)
  --grpc-port <port>       Host port for the agent gRPC endpoint (default: 9090)
  --force                  Overwrite an existing .env. The data volumes and the
                           database are kept, and PINGWAF_SECRET_KEY / the admin
                           password are reused from the old .env when present.
  --dry-run                Print the resolved plan and exit
  -h, --help               Show this help

Every option also has a PINGWAF_* environment variable (PINGWAF_TAG,
PINGWAF_COMPOSE_DIR, PINGWAF_ADMIN_EMAIL, ...), which keeps secrets out of the
command line and shell history. PINGWAF_SECRET_KEY is generated into .env when
unset and reused on --force; rotating it breaks previously sealed credentials.
EOF
}

die() {
    printf 'error: %s\n' "$1" >&2
    exit 1
}

warn() {
    printf 'warning: %s\n' "$1" >&2
}

require_value() { # $1 option, $2 next argument
    if [[ -z "${2:-}" ]]; then
        die "option $1 requires a value (use --help)"
    fi
    case "$2" in
        --*) die "option $1 requires a value, but got another option: $2" ;;
    esac
}

validate_port() { # $1 option, $2 value
    [[ "$2" =~ ^[0-9]+$ ]] || die "$1 must be a number"
    (( 10#$2 >= 1 && 10#$2 <= 65535 )) || die "$1 must be between 1 and 65535"
}

random_hex() { # $1 bytes (default 32) -> lowercase hex
    local bytes="${1:-32}"
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex "$bytes"
    else
        od -An -tx1 -N "$bytes" /dev/urandom | tr -d ' \n'
    fi
}

latest_release_tag() {
    local url="https://api.github.com/repos/${REPO}/releases/latest" tag=""
    if command -v curl >/dev/null 2>&1; then
        tag="$(curl -fsSL --proto '=https' "$url" 2>/dev/null \
            | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
            | head -n1)"
    elif command -v wget >/dev/null 2>&1; then
        tag="$(wget -qO- "$url" 2>/dev/null \
            | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
            | head -n1)"
    fi
    printf '%s' "${tag#v}"
}

random_password() { # $1 length (default 32) -> alphanumeric password
    local length="${1:-32}" raw=""
    if command -v openssl >/dev/null 2>&1; then
        raw="$(openssl rand -base64 48 2>/dev/null | tr -dc 'A-Za-z0-9' || true)"
    else
        raw="$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' || true)"
    fi
    if (( ${#raw} < length )); then
        raw="${raw}$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' || true)"
    fi
    printf '%s' "${raw:0:length}"
}

reject_control_chars() { # $1 label, $2 value
    if [[ "$2" == *[[:cntrl:]]* ]]; then
        die "$1 must not contain control characters"
    fi
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --tag) require_value "$1" "${2:-}"; TAG="$2"; shift 2 ;;
        --ref) require_value "$1" "${2:-}"; REF="$2"; shift 2 ;;
        --dir) require_value "$1" "${2:-}"; DIR="$2"; shift 2 ;;
        --admin-email) require_value "$1" "${2:-}"; ADMIN_EMAIL="$2"; shift 2 ;;
        --admin-password) require_value "$1" "${2:-}"; ADMIN_PASSWORD="$2"; shift 2 ;;
        --tls-sans) require_value "$1" "${2:-}"; TLS_SANS="$2"; shift 2 ;;
        --http-port) require_value "$1" "${2:-}"; HTTP_PORT="$2"; shift 2 ;;
        --https-port) require_value "$1" "${2:-}"; HTTPS_PORT="$2"; shift 2 ;;
        --admin-port) require_value "$1" "${2:-}"; ADMIN_PORT="$2"; shift 2 ;;
        --grpc-port) require_value "$1" "${2:-}"; GRPC_PORT="$2"; shift 2 ;;
        --force) FORCE=true; shift ;;
        --dry-run) DRY_RUN=true; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die "unknown option '$1' (use --help)" ;;
    esac
done

reject_control_chars "tag" "$TAG"
reject_control_chars "admin e-mail" "$ADMIN_EMAIL"
reject_control_chars "admin password" "$ADMIN_PASSWORD"
reject_control_chars "TLS SANs" "$TLS_SANS"
validate_port "--http-port" "$HTTP_PORT"
validate_port "--https-port" "$HTTPS_PORT"
validate_port "--admin-port" "$ADMIN_PORT"
validate_port "--grpc-port" "$GRPC_PORT"

if [[ -z "$REF" ]]; then
    if [[ "$TAG" == "main" ]]; then
        # `main` is the unstable development branch: allow it only when asked
        # for explicitly, and say so.
        warn "tag 'main' is the unstable development snapshot; pin a release tag for production"
        REF="main"
    elif [[ "$TAG" == "latest" ]]; then
        if [[ "$DRY_RUN" == "true" ]]; then
            # A dry run must not depend on the network; show what will happen.
            REF="<latest-release-tag>"
        else
            resolved="$(latest_release_tag)"
            if [[ -z "$resolved" ]]; then
                die "cannot resolve the latest release tag (GitHub API unreachable); pass --tag <version>"
            fi
            TAG="$resolved"
            REF="v${TAG}"
            printf 'Resolved latest release: %s\n' "$TAG"
        fi
    else
        REF="v${TAG#v}"
    fi
fi
COMPOSE_URL="https://raw.githubusercontent.com/${REPO}/${REF}/docker-compose.yml"

# .env values are read by compose, so the same newline/quote rules apply as in
# any shell assignment. Ports and e-mail are validated above; these three can
# contain arbitrary text.
env_value() {
    local value="$1"
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    value="${value//\$/\\$}"
    printf '%s' "$value"
}

if [[ "$DRY_RUN" == "true" ]]; then
    cat <<EOF
PingWAF Docker Compose install plan
  compose file : ${COMPOSE_URL}
  directory    : $(cd "$(dirname "$DIR")" 2>/dev/null && pwd || pwd)/$(basename "$DIR")
  image tag    : $([[ "$TAG" == "latest" ]] && echo "latest release (resolved at install)" || echo "$TAG")
  admin e-mail : ${ADMIN_EMAIL}
  admin passwd : $([[ -n "$ADMIN_PASSWORD" ]] && echo "custom" || echo "random (generated at install, printed once)")
  instance key : $([[ -n "$PINGWAF_SECRET_KEY" ]] && echo "from environment" || echo "generated into .env (0600)")
  tls sans     : ${TLS_SANS:-none (covers the hostname used to reach the console)}
  ports        : http ${HTTP_PORT}, https ${HTTPS_PORT}, admin ${ADMIN_PORT}, grpc ${GRPC_PORT}
EOF
    exit 0
fi

command -v docker >/dev/null 2>&1 || die "docker is not installed"
docker compose version >/dev/null 2>&1 || die "docker compose v2 is required (the 'docker compose' plugin, not docker-compose)"

mkdir -p "$DIR"
cd "$DIR"

if [[ -f .env && "$FORCE" != "true" ]]; then
    die "$(pwd)/.env already exists; re-run with --force to rewrite it (data volumes are kept)"
fi

# Reuse the secrets of an existing .env when --force rewrites it. Rotating the
# instance key would make every sealed notification/AI/backup credential
# unreadable (there is no automatic re-encryption).
existing_secret_key=""
existing_admin_password=""
if [[ -f .env ]]; then
    existing_secret_key="$(sed -n 's/^PINGWAF_SECRET_KEY=//p' .env | head -n1)"
    existing_admin_password="$(sed -n 's/^ADMIN_PASSWORD=//p' .env | head -n1)"
    # A .env written by an older installer carries the public default password;
    # do not keep it (the seeded account already exists, so a fresh random
    # value here is safe and stops the known default from staying on disk).
    if [[ "$existing_admin_password" == "pingwaf123" ]]; then
        existing_admin_password=""
    fi
fi
if [[ -z "$ADMIN_PASSWORD" && -n "$existing_admin_password" ]]; then
    ADMIN_PASSWORD="$existing_admin_password"
fi
if [[ -z "$ADMIN_PASSWORD" ]]; then
    ADMIN_PASSWORD="$(random_password)"
    ADMIN_PASSWORD_GENERATED=true
fi
if [[ -z "$PINGWAF_SECRET_KEY" ]]; then
    PINGWAF_SECRET_KEY="$existing_secret_key"
fi
if [[ -z "$PINGWAF_SECRET_KEY" ]]; then
    PINGWAF_SECRET_KEY="$(random_hex 32)"
fi

printf 'Downloading %s\n' "$COMPOSE_URL"
if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https' "$COMPOSE_URL" -o docker-compose.yml
else
    die "curl is required to download the compose file"
fi

# The compose file is taken from the release tag, so an older tag does not yet
# carry the hardening this installer assumes. Say so instead of pretending the
# instance key is in use.
if ! grep -q 'PINGWAF_SECRET_KEY' docker-compose.yml; then
    warn "the compose file for tag ${TAG} does not pass PINGWAF_SECRET_KEY to the container;"
    warn "at-rest sealing of notification/AI/backup credentials stays disabled until"
    warn "you upgrade to a release whose compose file includes it (or set it in the service)."
fi

umask 077
{
    printf 'PINGWAF_TAG=%s\n' "$(env_value "$TAG")"
    printf 'ADMIN_EMAIL=%s\n' "$(env_value "$ADMIN_EMAIL")"
    printf 'ADMIN_PASSWORD=%s\n' "$(env_value "$ADMIN_PASSWORD")"
    printf 'PINGWAF_SECRET_KEY=%s\n' "$(env_value "$PINGWAF_SECRET_KEY")"
    [[ -n "$TLS_SANS" ]] && printf 'PINGWAF_TLS_SANS=%s\n' "$(env_value "$TLS_SANS")"
    [[ "$HTTP_PORT" != "80" ]] && printf 'PINGWAF_HTTP_PORT=%s\n' "$HTTP_PORT"
    [[ "$HTTPS_PORT" != "443" ]] && printf 'PINGWAF_HTTPS_PORT=%s\n' "$HTTPS_PORT"
    [[ "$ADMIN_PORT" != "9080" ]] && printf 'PINGWAF_ADMIN_PORT=%s\n' "$ADMIN_PORT"
    [[ "$GRPC_PORT" != "9090" ]] && printf 'PINGWAF_GRPC_PORT=%s\n' "$GRPC_PORT"
} > .env
chmod 600 .env

printf 'Starting PingWAF (image tag %s)\n' "$TAG"
docker compose up -d

cat <<EOF

PingWAF is starting.

  Console : https://localhost:${ADMIN_PORT}  (self-signed certificate)
            the admin/gRPC ports are published on 127.0.0.1 by default; set
            PINGWAF_ADMIN_BIND/PINGWAF_GRPC_BIND to 0.0.0.0 only when a proxy or
            remote agents need them, and only after changing the password
  Account : ${ADMIN_EMAIL}
  Password: $([[ "$ADMIN_PASSWORD_GENERATED" == "true" ]] && echo "${ADMIN_PASSWORD} (generated — shown once, store it now)" || echo "stored in $(pwd)/.env")

The first boot pulls the image and initialises PostgreSQL; the console can take
a minute to answer. Follow it with:

  cd $(pwd) && docker compose logs -f pingwaf

Data volumes are never removed by this script, and "docker compose down" keeps
them too: only "docker compose down -v" (never use it) or deleting the volumes
by hand would destroy the database and the control-plane TLS material.

Upgrade later with:

  cd $(pwd) && docker compose pull && docker compose up -d

The .env keeps PINGWAF_SECRET_KEY and the administrator password; back it up
(0600) before a --force re-run, and do not rotate the instance key: sealed
notification/AI/backup credentials become unreadable.
EOF
