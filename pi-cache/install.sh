#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Thalassa Pi Cache — One-Command Install
#
# Public-beta default: loopback-only health/fixed-provider cache service.
# LAN/private routes require the explicit isolated-network flags documented
# in pi-cache/README.md.
#
#   sudo bash install.sh            first install, or rebuild in place
#   sudo thalassa-pi-cache-install   update: download the latest pi-cache, rebuild
#
# The source repository is private (2026-10). Downloading uses a read-only
# GitHub token, asked for once and kept in a root-only file,
# /etc/thalassa/github-token. Every download also installs a root-owned copy of
# this script as /usr/local/sbin/thalassa-pi-cache-install, so an update never
# runs the copy in /opt, which the service user can write.
# First install (and the first update of a Pi set up before 2026-10), from the
# owner's Mac:
#   scp pi-cache/install.sh <user>@<pi>:/tmp/ && ssh -t <user>@<pi> sudo bash /tmp/install.sh
#
# The Thalassa app on your phone will do the rest.
# ═══════════════════════════════════════════════════════════════

set -e

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${CYAN}${BOLD}  🌊  Thalassa Pi Cache${NC}"
echo -e "${CYAN}  ═════════════════════${NC}"
echo ""

# ── Resolve the real (non-root) user ──
# When run via "sudo bash install.sh" or piped through "sudo -S",
# $USER is root. $SUDO_USER is the human who invoked sudo.
REAL_USER="${SUDO_USER:-$USER}"
REAL_HOME=$(eval echo "~${REAL_USER}")

if [[ "$REAL_USER" == "root" ]]; then
    # Last resort: find first non-root user with a home dir
    REAL_USER=$(getent passwd 1000 | cut -d: -f1 || echo "pi")
    REAL_HOME=$(eval echo "~${REAL_USER}")
fi

echo -e "  Service user: ${BOLD}${REAL_USER}${NC}"

# ── Check for Linux ──

if [[ "$(uname)" != "Linux" ]]; then
    echo -e "${YELLOW}⚠️  This is meant for a Raspberry Pi.${NC}"
    echo -e "   Running on $(uname) — proceeding anyway.\n"
fi

# ── Find install directory ──
# In place only when this file sits in a pi-cache checkout (its package.json
# names thalassa-pi-cache). Piped into bash, BASH_SOURCE is empty and the
# current directory must never be mistaken for the install: any other case, or
# --update, downloads into /opt/thalassa-pi-cache.

UPDATE=0
[[ "${1:-}" == "--update" ]] && UPDATE=1
SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [[ "$UPDATE" == "0" && -n "$SCRIPT_DIR" ]] && grep -q '"name": "thalassa-pi-cache"' "$SCRIPT_DIR/package.json" 2>/dev/null; then
    # Running from a checked-out pi-cache — use this directory as-is.
    INSTALL_DIR="$SCRIPT_DIR"
else
    INSTALL_DIR="${THALASSA_INSTALL_DIR:-/opt/thalassa-pi-cache}"
    REPO_URL="${THALASSA_REPO_URL:-https://github.com/shanestratton/thalassa-marine-weather.git}"
    TOKEN_FILE="${THALASSA_TOKEN_FILE:-/etc/thalassa/github-token}"
    UPDATER="${THALASSA_UPDATER:-/usr/local/sbin/thalassa-pi-cache-install}"
    IS_FRESH_INSTALL=0
    [[ ! -d "$INSTALL_DIR" ]] || [[ ! -f "$INSTALL_DIR/package.json" ]] && IS_FRESH_INSTALL=1

    if [[ $EUID -ne 0 ]]; then
        echo -e "${RED}  Run it with sudo: sudo bash install.sh${NC}"
        exit 1
    fi
    if ! command -v git &>/dev/null; then
        echo -e "${RED}  Need git: sudo apt install git${NC}"
        exit 1
    fi

    # A fine-grained GitHub token with read-only Contents access to
    # thalassa-marine-weather: it reads the whole private repository, so only
    # the owner's own Pis get one. The file is root-only, which keeps it from
    # the cache service but not from a login user with sudo (Raspberry Pi OS
    # gives the default user passwordless sudo). Never put it in a URL or on a
    # command line: both are visible to every process on the Pi.
    if [[ ! -s "$TOKEN_FILE" ]]; then
        GITHUB_TOKEN=""
        if [[ -r /dev/tty ]]; then
            echo -e "  The Thalassa source is private. Paste your read-only GitHub token."
            echo -e "  It is kept root-only in ${TOKEN_FILE}; nothing is shown as you paste."
            IFS= read -rs GITHUB_TOKEN </dev/tty || true
            echo ""
        fi
        if [[ -z "$GITHUB_TOKEN" ]]; then
            echo -e "${RED}  No GitHub token: run this in a terminal on the Pi (sudo bash install.sh).${NC}"
            exit 1
        fi
        install -d -m 700 -o root -g root "$(dirname "$TOKEN_FILE")"
        (umask 077 && printf '%s' "$GITHUB_TOKEN" > "$TOKEN_FILE")
        chown root:root "$TOKEN_FILE"
        chmod 600 "$TOKEN_FILE"
        unset GITHUB_TOKEN
    fi

    # The token travels in an environment-only git config header for the
    # clone and its lazy blob fetches. printf is a shell builtin, so the token
    # is never an argument of any process.
    GIT_AUTH_HEADER="Authorization: Basic $(printf 'x-access-token:%s' "$(<"$TOKEN_FILE")" | base64 | tr -d '\n')"
    git_with_token() (
        export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1
        export GIT_CONFIG_KEY_0='http.https://github.com/.extraheader'
        export GIT_CONFIG_VALUE_0="$GIT_AUTH_HEADER"
        git "$@"
    )

    # Always pull fresh source (fresh install OR update). .env, cache/ and
    # identity/ live alongside the source and are preserved — we only replace code.
    if [[ "$IS_FRESH_INSTALL" == "1" ]]; then
        echo -e "  Downloading..."
    else
        echo -e "  Updating to latest..."
    fi

    mkdir -p "$INSTALL_DIR"
    CLONE_DIR="$(mktemp -d)"
    trap 'rm -rf "$CLONE_DIR"' EXIT
    if ! git_with_token clone --quiet --depth 1 --filter=blob:none --sparse "$REPO_URL" "$CLONE_DIR/repo" ||
        ! git_with_token -C "$CLONE_DIR/repo" sparse-checkout set pi-cache; then
        echo -e "${RED}  Download failed.${NC} If GitHub refused the token (401, 403 or not found), it is"
        echo -e "  wrong, expired or lacks read access to thalassa-marine-weather. Remove it with"
        echo -e "  'sudo rm ${TOKEN_FILE}' and run this again to paste a new one."
        exit 1
    fi
    unset GIT_AUTH_HEADER

    # Copy source over existing install. rsync preserves .env and cache/
    # because they don't exist in the source tree. Using --delete would be
    # dangerous — it would wipe .env and cache/ — so we just overlay.
    if command -v rsync &>/dev/null; then
        rsync -a --exclude='node_modules' --exclude='dist' \
            "$CLONE_DIR/repo/pi-cache/" "$INSTALL_DIR/"
    else
        # cp writes in place; if this very script is the one being replaced,
        # bash would read the new bytes mid-run. Unlink it first.
        rm -f "$INSTALL_DIR/install.sh"
        cp -r "$CLONE_DIR/repo/pi-cache/." "$INSTALL_DIR/"
    fi
    # Updates run this root-owned copy, never the service-writable one in /opt.
    install -D -m 0755 -o root -g root "$CLONE_DIR/repo/pi-cache/install.sh" "$UPDATER"
    rm -rf "$CLONE_DIR"
    trap - EXIT
fi

cd "$INSTALL_DIR"

# ── Fix ownership — everything should belong to the real user ──
chown -R "${REAL_USER}:${REAL_USER}" "$INSTALL_DIR"

# ── Enforce the supported Node.js runtime ──
# Undici 7 is the pinned outbound transport and requires Node >=20.18.1.
# npm's engine warning is not sufficient here because dependency output is
# deliberately quiet; an old runtime would otherwise install and fail at boot.

MIN_NODE_VERSION="20.18.1"

node_meets_minimum() {
    local candidate="$1"
    local version major minor patch
    version=$("$candidate" -p 'process.versions.node' 2>/dev/null) || return 1
    if [[ ! "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
        return 1
    fi
    major="${BASH_REMATCH[1]}"
    minor="${BASH_REMATCH[2]}"
    patch="${BASH_REMATCH[3]}"
    (( major > 20 )) ||
        (( major == 20 && minor > 18 )) ||
        (( major == 20 && minor == 18 && patch >= 1 ))
}

NODE_BIN=$(command -v node 2>/dev/null || true)
if [[ -z "$NODE_BIN" ]] || ! node_meets_minimum "$NODE_BIN"; then
    DETECTED_NODE_VERSION="not installed"
    if [[ -n "$NODE_BIN" ]]; then
        DETECTED_NODE_VERSION=$("$NODE_BIN" -v 2>/dev/null || echo "unreadable")
    fi
    echo -e "  Installing/upgrading Node.js (need >=${MIN_NODE_VERSION}; found ${DETECTED_NODE_VERSION})..."
    # Node 22 (LTS to April 2027): Signal K 2.32 on the same Pi requires >=22, and the
    # boat moved to NodeSource 22.x on 2026-09-10. Anything >=MIN_NODE_VERSION already
    # installed is left alone.
    if ! curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1; then
        echo -e "  ${RED}✗${NC} Could not configure the Node.js 22 package repository."
        exit 1
    fi
    if ! apt-get install -y nodejs >/dev/null 2>&1; then
        echo -e "  ${RED}✗${NC} Could not install Node.js >=${MIN_NODE_VERSION}."
        exit 1
    fi
    hash -r
    NODE_BIN=$(command -v node 2>/dev/null || true)
fi

if [[ -z "$NODE_BIN" ]] || ! node_meets_minimum "$NODE_BIN"; then
    DETECTED_NODE_VERSION="not installed"
    if [[ -n "$NODE_BIN" ]]; then
        DETECTED_NODE_VERSION=$("$NODE_BIN" -v 2>/dev/null || echo "unreadable")
    fi
    echo -e "  ${RED}✗${NC} Node.js >=${MIN_NODE_VERSION} is required; found ${DETECTED_NODE_VERSION}."
    echo -e "  ${RED}Aborting before dependency installation or service restart.${NC}"
    exit 1
fi

NODE_BIN=$(readlink -f "$NODE_BIN" 2>/dev/null || echo "$NODE_BIN")
echo -e "  ${GREEN}✓${NC} Node.js $("$NODE_BIN" -v)"

# ── Install & build ──
# Run npm as the real user to avoid root-owned node_modules

echo -e "  Installing dependencies..."
sudo -u "$REAL_USER" npm ci --prefix "$INSTALL_DIR" --no-audit --no-fund >/dev/null 2>&1
echo -e "  ${GREEN}✓${NC} Dependencies installed"

echo -e "  Building..."
# Capture build output so a failure is visible. Without this, set -e
# kills the script silently on any tsc error and the user just sees
# "Building..." then prompt — happened in the Phase 13 deploy when
# @types/geojson wasn't pinned. Spend the screen real estate; surface
# the failure.
BUILD_LOG="$INSTALL_DIR/.last-build.log"
if ! sudo -u "$REAL_USER" npm run build --prefix "$INSTALL_DIR" >"$BUILD_LOG" 2>&1; then
    echo -e "  ${RED}✗${NC} Build failed. Output:"
    sed 's/^/    /' "$BUILD_LOG" | head -40
    echo ""
    echo -e "  ${RED}Aborting install.${NC} Full log: $BUILD_LOG"
    exit 1
fi
echo -e "  ${GREEN}✓${NC} Built"

# Remove devDependencies (typescript etc.) to save ~50MB on the Pi.
sudo -u "$REAL_USER" npm prune --omit=dev --prefix "$INSTALL_DIR" --no-audit >/dev/null 2>&1

# ── Create cache directory ──

mkdir -p "$INSTALL_DIR/cache"
mkdir -p "$INSTALL_DIR/enc-charts/cells"
chown -R "${REAL_USER}:${REAL_USER}" "$INSTALL_DIR"

# ── Create minimal fail-closed .env ──

if [[ ! -f "$INSTALL_DIR/.env" ]]; then
    cat > "$INSTALL_DIR/.env" <<'ENVEOF'
# Thalassa Pi Cache — auto-generated
# Public-beta defaults: loopback only, no private/admin routes, no ENC watcher.
# See README.md before enabling any unsafe development flag.
PORT=3001
CACHE_DIR=./cache
THALASSA_PI_LAN_BIND=0
THALASSA_UNSAFE_ADMIN_API=0
ENC_WATCHER_ENABLED=false
ENVEOF
    chown "${REAL_USER}:${REAL_USER}" "$INSTALL_DIR/.env"
fi

# ── Create systemd service ──

SERVICE_FILE="/etc/systemd/system/thalassa-cache.service"

tee "$SERVICE_FILE" > /dev/null <<SVCEOF
[Unit]
Description=Thalassa Pi Cache
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=${REAL_USER}
WorkingDirectory=${INSTALL_DIR}
ExecStart=${NODE_BIN} dist/server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Nice=-5
LimitNOFILE=65535
StandardOutput=journal
StandardError=journal
SyslogIdentifier=thalassa-cache

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload >/dev/null 2>&1
systemctl enable thalassa-cache >/dev/null 2>&1
systemctl restart thalassa-cache >/dev/null 2>&1

# ── Tailscale (installed idle — remote access is enabled from the app) ──
# The punter never touches this: the paired Thalassa app drives
# /api/remote-access, which runs `tailscale up` and hands the sign-in URL
# back to the phone. We only pre-install the daemon and grant the service
# user operator rights so that flow works unprivileged. Non-fatal when the
# install is running offline — the endpoint reports 'not-installed' and the
# app explains.
if ! command -v tailscale &>/dev/null; then
    echo -e "  Installing tailscale (idle until enabled from the app)..."
    curl -fsSL https://tailscale.com/install.sh | sh >/dev/null 2>&1 || \
        echo -e "  ${YELLOW}⚠ tailscale install skipped (offline?) — remote access unavailable until installed${NC}"
fi
if command -v tailscale &>/dev/null; then
    systemctl enable --now tailscaled >/dev/null 2>&1 || true
    # Let the unprivileged service user drive `tailscale up/down`.
    tailscale set --operator="${REAL_USER}" >/dev/null 2>&1 || true
fi

# ── Publish mDNS only after explicit LAN opt-in ──
# Do not advertise a loopback-only service to the boat LAN.

if grep -Eq '^THALASSA_PI_LAN_BIND=1$' "$INSTALL_DIR/.env"; then
    if ! command -v avahi-daemon &>/dev/null; then
        echo -e "  Installing avahi..."
        apt-get install -y avahi-daemon avahi-utils >/dev/null 2>&1
    fi
    systemctl enable --now avahi-daemon >/dev/null 2>&1

# ── Install GDAL for ENC (S-57) chart conversion ──
# pi-cache exposes /api/enc/convert which shells out to ogr2ogr to
# transform user-imported S-57 cells into GeoJSON for routing-grade
# hazard checks. GDAL is a one-line apt install on Raspberry Pi OS.

if ! command -v ogr2ogr &>/dev/null; then
    echo -e "  Installing GDAL (for ENC chart conversion)..."
    apt-get install -y gdal-bin >/dev/null 2>&1
fi

    AVAHI_SERVICE_FILE="/etc/avahi/services/thalassa-cache.service"
    tee "$AVAHI_SERVICE_FILE" > /dev/null <<'AVAHIEOF'
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">Thalassa Pi Cache on %h</name>
  <service>
    <type>_thalassa-cache._tcp</type>
    <port>3001</port>
    <txt-record>service=thalassa-pi-cache</txt-record>
    <txt-record>version=1</txt-record>
  </service>
</service-group>
AVAHIEOF

    # Avahi watches /etc/avahi/services/ and reloads automatically, but a
    # restart guarantees the record is live before we report success.
    systemctl restart avahi-daemon >/dev/null 2>&1
    echo -e "  ${GREEN}✓${NC} mDNS published (_thalassa-cache._tcp)"
else
    echo -e "  ${YELLOW}!${NC} LAN/mDNS disabled (public-beta safe default)"
fi

# ── Chart download permissions ──
# pi-cache's new /api/charts/download endpoint writes chart files (NOAA
# MBTiles, LINZ packages, community charts) into AvNav's chart directory
# so AvNav picks them up automatically. AvNav owns /var/lib/avnav/charts
# as the `avnav` user; pi-cache runs as ${REAL_USER}. We add ${REAL_USER}
# to the avnav group and make the chart dir group-writable so the API
# can write without escalating privileges.
#
# Idempotent — safe on every install. If avnav isn't installed yet, this
# block is a no-op (skipper will need to re-run install.sh after avnav
# is set up to pick up permissions).
if [[ -d /var/lib/avnav/charts ]] && getent group avnav >/dev/null 2>&1; then
    usermod -a -G avnav "${REAL_USER}" 2>/dev/null || true
    chmod 775 /var/lib/avnav/charts 2>/dev/null || true
    echo -e "  ${GREEN}✓${NC} Chart download permissions configured"
else
    echo -e "  ${YELLOW}!${NC} AvNav not detected — chart downloads will fail until avnav is installed"
    echo -e "    (Re-run install.sh after installing avnav to fix.)"
fi

sleep 2

# ── Done ──

if systemctl is-active --quiet thalassa-cache; then
    echo ""
    echo -e "${GREEN}${BOLD}  ✓ Done!${NC}"
    echo ""
    echo -e "  Public-beta safe mode is active: loopback only, private routes disabled."
    echo -e "  See ${BOLD}${INSTALL_DIR}/README.md${NC} for isolated development flags."
    echo ""
    echo -e "  ${CYAN}https://127.0.0.1:3001/health${NC}  (self-signed — curl needs --cacert identity/identity-cert.pem)"
    echo ""
else
    echo -e "\n${RED}  Something went wrong. Run: sudo journalctl -u thalassa-cache -f${NC}\n"
    exit 1
fi
