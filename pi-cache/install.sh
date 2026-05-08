#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Thalassa Pi Cache — One-Command Install
#
# Just run this on your Raspberry Pi. No questions. No config.
#
#   bash install.sh
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}" 2>/dev/null || echo ".")" && pwd)"
if [[ -f "$SCRIPT_DIR/package.json" ]]; then
    # Running from a checked-out repo — use this directory as-is.
    INSTALL_DIR="$SCRIPT_DIR"
else
    INSTALL_DIR="/opt/thalassa-pi-cache"
    IS_FRESH_INSTALL=0
    [[ ! -d "$INSTALL_DIR" ]] || [[ ! -f "$INSTALL_DIR/package.json" ]] && IS_FRESH_INSTALL=1

    if ! command -v git &>/dev/null; then
        echo -e "${RED}  Need git: sudo apt install git${NC}"
        exit 1
    fi

    # Always pull fresh source (fresh install OR update). .env and cache/
    # live alongside the source and are preserved — we only replace code.
    if [[ "$IS_FRESH_INSTALL" == "1" ]]; then
        echo -e "  Downloading..."
    else
        echo -e "  Updating to latest..."
    fi

    mkdir -p "$INSTALL_DIR"
    rm -rf /tmp/thalassa-clone
    git clone --depth 1 --filter=blob:none --sparse \
        https://github.com/shanestratton/thalassa-marine-weather.git /tmp/thalassa-clone 2>/dev/null
    cd /tmp/thalassa-clone && git sparse-checkout set pi-cache 2>/dev/null

    # Copy source over existing install. rsync preserves .env and cache/
    # because they don't exist in the source tree. Using --delete would be
    # dangerous — it would wipe .env and cache/ — so we just overlay.
    if command -v rsync &>/dev/null; then
        rsync -a --exclude='node_modules' --exclude='dist' \
            /tmp/thalassa-clone/pi-cache/ "$INSTALL_DIR/"
    else
        cp -r /tmp/thalassa-clone/pi-cache/* "$INSTALL_DIR/"
    fi
    rm -rf /tmp/thalassa-clone
fi

cd "$INSTALL_DIR"

# ── Fix ownership — everything should belong to the real user ──
chown -R "${REAL_USER}:${REAL_USER}" "$INSTALL_DIR"

# ── Install Node.js if missing ──

if ! command -v node &>/dev/null; then
    echo -e "  Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
    apt-get install -y nodejs >/dev/null 2>&1
fi
echo -e "  ${GREEN}✓${NC} Node.js $(node -v)"

# ── Install & build ──
# Run npm as the real user to avoid root-owned node_modules

echo -e "  Installing dependencies..."
sudo -u "$REAL_USER" npm install --prefix "$INSTALL_DIR" >/dev/null 2>&1
echo -e "  ${GREEN}✓${NC} Dependencies installed"

echo -e "  Building..."
sudo -u "$REAL_USER" npm run build --prefix "$INSTALL_DIR" >/dev/null 2>&1
echo -e "  ${GREEN}✓${NC} Built"

# Remove devDependencies (typescript etc.) to save ~50MB on the Pi
sudo -u "$REAL_USER" npm prune --production --prefix "$INSTALL_DIR" >/dev/null 2>&1

# ── Create cache directory ──

mkdir -p "$INSTALL_DIR/cache"
mkdir -p "$INSTALL_DIR/enc-charts/cells"
chown -R "${REAL_USER}:${REAL_USER}" "$INSTALL_DIR"

# ── Create minimal .env (no secrets — the app pushes config later) ──

if [[ ! -f "$INSTALL_DIR/.env" ]]; then
    cat > "$INSTALL_DIR/.env" <<'ENVEOF'
# Thalassa Pi Cache — auto-generated
# The Thalassa app on your phone will configure this.
# You don't need to edit anything here.
PORT=3001
CACHE_DIR=./cache
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
ExecStart=/usr/bin/node dist/server.js
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

# ── Publish mDNS service record ──
# Advertise _thalassa-cache._tcp so the iOS app can discover this Pi by
# service type instead of guessing hostnames. This way the user can rename
# the host to anything (bosun, helm, whatever) and discovery still works.

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

PI_IP=$(hostname -I | awk '{print $1}')

if systemctl is-active --quiet thalassa-cache; then
    echo ""
    echo -e "${GREEN}${BOLD}  ✓ Done!${NC}"
    echo ""
    echo -e "  Now open Thalassa on your phone"
    echo -e "  Go to ${BOLD}Settings → Boat Network${NC} (or Nav Station → Boat Network)"
    echo -e "  Flip the toggle — it'll find this Pi automatically."
    echo ""
    echo -e "  ${CYAN}http://${PI_IP}:3001${NC}"
    echo ""
else
    echo -e "\n${RED}  Something went wrong. Run: sudo journalctl -u thalassa-cache -f${NC}\n"
    exit 1
fi
