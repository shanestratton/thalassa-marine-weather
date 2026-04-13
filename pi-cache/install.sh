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

# ── Check for Linux ──

if [[ "$(uname)" != "Linux" ]]; then
    echo -e "${YELLOW}⚠️  This is meant for a Raspberry Pi.${NC}"
    echo -e "   Running on $(uname) — proceeding anyway.\n"
fi

# ── Find install directory ──

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}" 2>/dev/null || echo ".")" && pwd)"
if [[ -f "$SCRIPT_DIR/package.json" ]]; then
    INSTALL_DIR="$SCRIPT_DIR"
else
    INSTALL_DIR="/opt/thalassa-pi-cache"
    if [[ ! -d "$INSTALL_DIR" ]]; then
        sudo mkdir -p "$INSTALL_DIR"
        sudo chown "$USER:$USER" "$INSTALL_DIR"
        if command -v git &>/dev/null; then
            echo -e "  Downloading..."
            git clone --depth 1 --filter=blob:none --sparse \
                https://github.com/shanestratton/thalassa-marine-weather.git /tmp/thalassa-clone 2>/dev/null
            cd /tmp/thalassa-clone && git sparse-checkout set pi-cache 2>/dev/null
            cp -r pi-cache/* "$INSTALL_DIR/"
            rm -rf /tmp/thalassa-clone
        else
            echo -e "${RED}  Need git: sudo apt install git${NC}"
            exit 1
        fi
    fi
fi

cd "$INSTALL_DIR"

# ── Install Node.js if missing ──

if ! command -v node &>/dev/null; then
    echo -e "  Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - >/dev/null 2>&1
    sudo apt-get install -y nodejs >/dev/null 2>&1
fi
echo -e "  ${GREEN}✓${NC} Node.js $(node -v)"

# ── Install & build ──

echo -e "  Installing dependencies..."
npm install --production >/dev/null 2>&1
echo -e "  ${GREEN}✓${NC} Dependencies installed"

echo -e "  Building..."
npm run build >/dev/null 2>&1
echo -e "  ${GREEN}✓${NC} Built"

# ── Create minimal .env (no secrets — the app pushes config later) ──

if [[ ! -f ".env" ]]; then
    cat > .env <<'ENVEOF'
# Thalassa Pi Cache — auto-generated
# The Thalassa app on your phone will configure this.
# You don't need to edit anything here.
PORT=3001
CACHE_DIR=./cache
ENVEOF
fi

# ── Create systemd service ──

SERVICE_FILE="/etc/systemd/system/thalassa-cache.service"

sudo tee "$SERVICE_FILE" > /dev/null <<SVCEOF
[Unit]
Description=Thalassa Pi Cache
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$INSTALL_DIR
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

sudo systemctl daemon-reload >/dev/null 2>&1
sudo systemctl enable thalassa-cache >/dev/null 2>&1
sudo systemctl start thalassa-cache >/dev/null 2>&1

sleep 2

# ── Done ──

PI_IP=$(hostname -I | awk '{print $1}')

if sudo systemctl is-active --quiet thalassa-cache; then
    echo ""
    echo -e "${GREEN}${BOLD}  ✓ Done!${NC}"
    echo ""
    echo -e "  Now open Thalassa on your phone"
    echo -e "  Go to ${BOLD}Settings → Pi Cache${NC}"
    echo -e "  Flip the toggle — it'll find this Pi automatically."
    echo ""
    echo -e "  ${CYAN}http://${PI_IP}:3001${NC}"
    echo ""
else
    echo -e "\n${RED}  Something went wrong. Run: sudo journalctl -u thalassa-cache -f${NC}\n"
    exit 1
fi
