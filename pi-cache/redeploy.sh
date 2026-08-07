#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Thalassa Pi Cache — Redeploy from Source
#
# Use this AFTER `install.sh` has set up the systemd service. Picks
# up the latest source from the repo working tree (typically
# ~/thalassa-marine-weather/pi-cache after a git pull), rsyncs it
# to /opt/thalassa-pi-cache where systemd actually runs from,
# installs deps, compiles TypeScript, and restarts the service.
#
# Usage (from anywhere on the Pi):
#
#   ~/thalassa-marine-weather/pi-cache/redeploy.sh
#
# or:
#
#   cd ~/thalassa-marine-weather/pi-cache && ./redeploy.sh
#
# Every redeploy performs a clean lockfile install before compiling, then
# removes development dependencies before restarting the production service.
# ═══════════════════════════════════════════════════════════════

set -e

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

# Source tree = wherever this script lives.
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="/opt/thalassa-pi-cache"
SERVICE_NAME="thalassa-cache"
HEALTH_URL="https://localhost:3001/health"
PROBE_URL="https://localhost:3001/api/enc/route-prepped"
# The Pi serves TLS with a certificate issued from its pairing key. Validating
# the probes AGAINST that certificate — rather than passing -k — makes this a
# real check that the cert the app will pin is the one being served, on every
# redeploy. WorkingDirectory is INSTALL_DIR, so IDENTITY_DIR resolves here.
PI_CERT="${INSTALL_DIR}/identity/identity-cert.pem"

echo ""
echo -e "${CYAN}${BOLD}  🌊  Thalassa Pi Cache — Redeploy${NC}"
echo -e "${CYAN}  ═════════════════════════════════${NC}"
echo ""
echo -e "  Source: ${BOLD}${SOURCE_DIR}${NC}"
echo -e "  Target: ${BOLD}${INSTALL_DIR}${NC}"
echo ""

# ── Prereqs ─────────────────────────────────────────────────────
if [[ ! -d "$INSTALL_DIR" ]]; then
    echo -e "${RED}  ✗ $INSTALL_DIR doesn't exist.${NC}"
    echo -e "    Run ${BOLD}bash install.sh${NC} first to set up the service."
    exit 1
fi
if ! systemctl list-unit-files | grep -q "^${SERVICE_NAME}\.service"; then
    echo -e "${RED}  ✗ systemd service '${SERVICE_NAME}' is not installed.${NC}"
    echo -e "    Run ${BOLD}bash install.sh${NC} first."
    exit 1
fi
if [[ ! -f "$SOURCE_DIR/package.json" ]]; then
    echo -e "${RED}  ✗ $SOURCE_DIR doesn't look like the pi-cache source.${NC}"
    exit 1
fi

# ── Sync source ────────────────────────────────────────────────
echo -e "  ${CYAN}1/5${NC} Syncing source → ${INSTALL_DIR}..."
sudo rsync -a --delete \
    --exclude=node_modules \
    --exclude=dist \
    --exclude=.env \
    --exclude=cache \
    --exclude=enc-charts \
    --exclude=identity \
    --exclude=app-dist \
    --exclude=.git \
    "$SOURCE_DIR/" "$INSTALL_DIR/"

# Reset ownership in case rsync ran as root and left root-owned files.
REAL_USER="${SUDO_USER:-$USER}"
sudo chown -R "${REAL_USER}:${REAL_USER}" "$INSTALL_DIR"
echo -e "      ${GREEN}✓${NC} source copied"

# ── Clean locked install ───────────────────────────────────────────────
echo -e "  ${CYAN}2/5${NC} Installing the exact locked dependency tree..."
cd "$INSTALL_DIR"
npm ci --silent --no-audit --no-fund
echo -e "      ${GREEN}✓${NC} deps installed"

# ── Build ──────────────────────────────────────────────────────
echo -e "  ${CYAN}3/5${NC} Compiling TypeScript..."
cd "$INSTALL_DIR"
rm -rf dist
npm run build --silent
echo -e "      ${GREEN}✓${NC} dist/ rebuilt"

# TypeScript and test tooling are build-only. The long-running service keeps
# only its production dependency closure.
npm prune --omit=dev --silent --no-audit
echo -e "      ${GREEN}✓${NC} development deps pruned"

# ── LAN reachability opt-in ────────────────────────────────────
# THALASSA_PI_LAN_BIND arrived with the public-beta boundary, AFTER some Pis
# were installed. install.sh writes it (=0) for fresh installs, and this script
# deliberately excludes .env from the rsync so local settings survive — so a Pi
# installed before that flag existed simply has no line for it, and
# resolveBindHost() falls through to its 127.0.0.1 default. The service then
# starts perfectly, reports itself healthy, and is unreachable from the boat.
#
# Shane lost an hour to exactly that on 2026-08-07: the phone said "Pi not
# connected" while systemctl said active (running), because the only trace was
# one line of the startup banner. Say it here instead.
if [[ -f "$INSTALL_DIR/.env" ]] && ! grep -Eq '^THALASSA_PI_LAN_BIND=1$' "$INSTALL_DIR/.env"; then
    echo ""
    echo -e "${YELLOW}  ⚠  LAN access is OFF — this Pi will only answer on localhost.${NC}"
    echo -e "     Nothing on the boat network (the app included) can reach it."
    echo -e "     To enable:"
    echo -e "       ${BOLD}echo 'THALASSA_PI_LAN_BIND=1' | sudo tee -a ${INSTALL_DIR}/.env${NC}"
    echo -e "       ${BOLD}sudo systemctl enable --now avahi-daemon${NC}   # for calypso.local"
    echo -e "       ${BOLD}sudo systemctl restart ${SERVICE_NAME}${NC}"
    echo ""
fi

# ── Restart ────────────────────────────────────────────────────
echo -e "  ${CYAN}4/5${NC} Restarting ${SERVICE_NAME}..."
sudo systemctl restart "${SERVICE_NAME}"
sleep 2
if systemctl is-active --quiet "${SERVICE_NAME}"; then
    echo -e "      ${GREEN}✓${NC} service active"
else
    echo -e "${RED}  ✗ Service failed to start. Recent logs:${NC}"
    sudo journalctl -u "${SERVICE_NAME}" -n 20 --no-pager
    exit 1
fi

# ── Health probe ───────────────────────────────────────────────
echo -e "  ${CYAN}5/5${NC} Probing endpoints..."

if [[ -f "$PI_CERT" ]]; then
    CURL_TLS=(--cacert "$PI_CERT")
    echo -e "      ${GREEN}✓${NC} probing over TLS against $(basename "$PI_CERT")"
else
    # First redeploy after the TLS switch: the cert is minted at startup, so a
    # missing file here means the service never got that far.
    echo -e "${YELLOW}      ⚠ no certificate at ${PI_CERT} — did the service start?${NC}"
    CURL_TLS=(--insecure)
fi

HEALTH_CODE=$(curl -s "${CURL_TLS[@]}" -o /dev/null -w "%{http_code}" "$HEALTH_URL")
if [[ "$HEALTH_CODE" == "200" ]]; then
    echo -e "      ${GREEN}✓${NC} /health → HTTP 200"
elif [[ "$HEALTH_CODE" == "000" ]]; then
    echo -e "${RED}      ✗ /health → no TLS handshake.${NC}"
    echo -e "        The service may still be serving plain HTTP, or openssl is missing."
    echo -e "        Check: ${BOLD}sudo journalctl -u ${SERVICE_NAME} -n 30 --no-pager${NC}"
    exit 1
else
    echo -e "${YELLOW}      ⚠ /health → HTTP ${HEALTH_CODE}${NC}"
fi

# Private route — 503 is the public-beta safe default. An explicitly unsafe
# development server returns 400 for this intentionally empty body.
PROBE_CODE=$(curl -s "${CURL_TLS[@]}" -o /dev/null -w "%{http_code}" \
    -X POST "$PROBE_URL" \
    -H "Content-Type: application/json" \
    -d '{}')
if [[ "$PROBE_CODE" == "503" ]]; then
    echo -e "      ${GREEN}✓${NC} /api/enc/route-prepped → HTTP 503 (private API disabled — safe default)"
elif [[ "$PROBE_CODE" == "400" ]]; then
    echo -e "      ${YELLOW}⚠${NC} /api/enc/route-prepped → HTTP 400 (unsafe development API enabled)"
elif [[ "$PROBE_CODE" == "404" ]]; then
    echo -e "${RED}      ✗ /api/enc/route-prepped → HTTP 404 — dist may be stale${NC}"
    exit 1
else
    echo -e "${YELLOW}      ⚠ /api/enc/route-prepped → HTTP ${PROBE_CODE} (unexpected)${NC}"
fi

echo ""
echo -e "${GREEN}${BOLD}  ✓ Redeploy complete.${NC}"
echo -e "  Tail logs with: ${BOLD}sudo journalctl -u ${SERVICE_NAME} -f${NC}"
echo ""
